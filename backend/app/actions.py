"""Actions limited to KubeLab's own workloads."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from kubernetes import client
from kubernetes.client.exceptions import ApiException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.kubernetes_service import REQUEST_TIMEOUT

APP_NAMESPACE = "kubelab"
ALLOWED_DEPLOYMENTS = frozenset({"kubelab-backend", "kubelab-frontend"})
MIN_REPLICAS = 1
MAX_REPLICAS = 6

PodName = Annotated[
    str,
    Path(
        min_length=1,
        max_length=253,
        pattern=r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$",
    ),
]


class ScaleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uid: UUID
    replicas: Annotated[
        StrictInt,
        Field(ge=MIN_REPLICAS, le=MAX_REPLICAS),
    ]


class DeletePodRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    uid: UUID


class ActionAccepted(BaseModel):
    status: Literal["accepted"] = "accepted"
    namespace: str = APP_NAMESPACE
    action: Literal["scale", "delete_pod"]
    name: str
    uid: str
    replicas: int | None = None
    deployment: str | None = None


def require_json(request: Request) -> None:
    """Keep mutation requests explicit JSON even without a dashboard login."""
    if request.method == "POST":
        media_type = request.headers.get("content-type", "")
        media_type = media_type.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise HTTPException(415, "Use Content-Type: application/json.")


router = APIRouter(
    prefix="/api/actions",
    tags=["actions"],
    dependencies=[Depends(require_json)],
)


def action_api_error(error: ApiException) -> HTTPException:
    if error.status == 404:
        return HTTPException(404, "The Kubernetes object no longer exists.")
    if error.status == 409:
        return HTTPException(409, "The object changed. Refresh and retry.")
    if error.status in {401, 403}:
        return HTTPException(503, "The backend lacks Kubernetes permission.")
    return HTTPException(503, "The Kubernetes action request failed.")


def controller_owner(
    metadata: client.V1ObjectMeta,
    kind: str,
) -> client.V1OwnerReference:
    owners = [
        owner
        for owner in metadata.owner_references or []
        if owner.controller is True
    ]
    if (
        len(owners) != 1
        or owners[0].api_version != "apps/v1"
        or owners[0].kind != kind
        or not owners[0].name
        or not owners[0].uid
    ):
        raise HTTPException(403, "This Pod is outside the allowed ownership chain.")
    return owners[0]


@router.get("/session")
def action_policy() -> dict[str, object]:
    return {
        "namespace": APP_NAMESPACE,
        "deployments": sorted(ALLOWED_DEPLOYMENTS),
        "min_replicas": MIN_REPLICAS,
        "max_replicas": MAX_REPLICAS,
    }


@router.post(
    "/deployments/{name}/scale",
    response_model=ActionAccepted,
    status_code=202,
)
def scale_deployment(
    name: str,
    payload: ScaleRequest,
    request: Request,
) -> ActionAccepted:
    if name not in ALLOWED_DEPLOYMENTS:
        raise HTTPException(403, "Only KubeLab Deployments can be scaled.")

    apps = client.AppsV1Api(request.app.state.kubernetes.api_client)
    try:
        current = apps.read_namespaced_deployment_scale(
            name=name,
            namespace=APP_NAMESPACE,
            _request_timeout=REQUEST_TIMEOUT,
        )
        if current.metadata.uid != str(payload.uid):
            raise HTTPException(409, "The Deployment changed. Refresh and retry.")
        if not current.metadata.resource_version:
            raise HTTPException(503, "Kubernetes returned incomplete metadata.")

        apps.patch_namespaced_deployment_scale(
            name=name,
            namespace=APP_NAMESPACE,
            body={
                "metadata": {
                    "uid": current.metadata.uid,
                    "resourceVersion": current.metadata.resource_version,
                },
                "spec": {"replicas": payload.replicas},
            },
            _content_type="application/merge-patch+json",
            _request_timeout=REQUEST_TIMEOUT,
        )
    except ApiException as error:
        raise action_api_error(error) from None

    return ActionAccepted(
        action="scale",
        name=name,
        uid=str(payload.uid),
        replicas=payload.replicas,
    )


@router.post(
    "/pods/{name}/delete",
    response_model=ActionAccepted,
    status_code=202,
)
def delete_pod(
    name: PodName,
    payload: DeletePodRequest,
    request: Request,
) -> ActionAccepted:
    service = request.app.state.kubernetes
    apps = client.AppsV1Api(service.api_client)

    try:
        pod = service.core.read_namespaced_pod(
            name=name,
            namespace=APP_NAMESPACE,
            _request_timeout=REQUEST_TIMEOUT,
        )
        if pod.metadata.uid != str(payload.uid):
            raise HTTPException(409, "The Pod changed. Refresh and retry.")
        if pod.metadata.deletion_timestamp is not None:
            raise HTTPException(409, "This Pod is already being deleted.")

        replica_set_owner = controller_owner(pod.metadata, "ReplicaSet")
        replica_set = apps.read_namespaced_replica_set(
            name=replica_set_owner.name,
            namespace=APP_NAMESPACE,
            _request_timeout=REQUEST_TIMEOUT,
        )
        if replica_set.metadata.uid != replica_set_owner.uid:
            raise HTTPException(409, "The ReplicaSet changed. Refresh and retry.")

        deployment_owner = controller_owner(replica_set.metadata, "Deployment")
        if deployment_owner.name not in ALLOWED_DEPLOYMENTS:
            raise HTTPException(403, "This Pod is outside the allowed Deployments.")

        deployment = apps.read_namespaced_deployment(
            name=deployment_owner.name,
            namespace=APP_NAMESPACE,
            _request_timeout=REQUEST_TIMEOUT,
        )
        if deployment.metadata.uid != deployment_owner.uid:
            raise HTTPException(409, "The Deployment changed. Refresh and retry.")
        if (
            replica_set.metadata.deletion_timestamp is not None
            or deployment.metadata.deletion_timestamp is not None
        ):
            raise HTTPException(409, "The owning workload is being deleted.")
        if not pod.metadata.resource_version:
            raise HTTPException(503, "Kubernetes returned incomplete metadata.")

        service.core.delete_namespaced_pod(
            name=name,
            namespace=APP_NAMESPACE,
            body=client.V1DeleteOptions(
                preconditions=client.V1Preconditions(
                    uid=pod.metadata.uid,
                    resource_version=pod.metadata.resource_version,
                ),
            ),
            _request_timeout=REQUEST_TIMEOUT,
        )
    except ApiException as error:
        raise action_api_error(error) from None

    return ActionAccepted(
        action="delete_pod",
        name=name,
        uid=str(payload.uid),
        deployment=deployment_owner.name,
    )
