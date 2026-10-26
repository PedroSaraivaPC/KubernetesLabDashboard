"""Read-only workload queries and HTTP routes."""

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from kubernetes import client

from app.kubernetes_service import REQUEST_TIMEOUT
from app.models import (
    ContainerSummary,
    DeploymentSummary,
    DeploymentsResponse,
    PodSummary,
    PodsResponse,
)


router = APIRouter(prefix="/api", tags=["workloads"])

NamespaceFilter = Annotated[
    str | None,
    Query(
        min_length=1,
        max_length=63,
        pattern=r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
        description="Omit to include all namespaces.",
    ),
]


def summarize_containers(
    specs: list[client.V1Container] | None,
    statuses: list[client.V1ContainerStatus] | None,
    kind: Literal["regular", "init"],
) -> list[ContainerSummary]:
    statuses_by_name = {
        status.name: status
        for status in statuses or []
    }
    containers = []

    for spec in specs or []:
        status = statuses_by_name.get(spec.name)
        state = status.state if status is not None else None

        state_name = "unknown"
        reason = None
        exit_code = None

        if state is not None:
            if state.running is not None:
                state_name = "running"
            elif state.waiting is not None:
                state_name = "waiting"
                reason = state.waiting.reason
            elif state.terminated is not None:
                state_name = "terminated"
                reason = state.terminated.reason
                exit_code = state.terminated.exit_code

        containers.append(
            ContainerSummary(
                name=spec.name,
                kind=kind,
                image=spec.image,
                image_id=(
                    status.image_id if status is not None else None
                ),
                ready=(
                    status.ready if status is not None else None
                ),
                restart_count=(
                    status.restart_count if status is not None else None
                ),
                state=state_name,
                reason=reason,
                exit_code=exit_code,
            )
        )

    return containers


def summarize_pod(pod: client.V1Pod) -> PodSummary:
    metadata = pod.metadata
    status = pod.status
    ready = "Unknown"

    if status is not None:
        for condition in status.conditions or []:
            if condition.type == "Ready":
                ready = condition.status
                break

    owner = next(
        (
            reference
            for reference in metadata.owner_references or []
            if reference.controller
        ),
        None,
    )

    containers = summarize_containers(
        pod.spec.containers,
        status.container_statuses if status is not None else None,
        "regular",
    )
    containers.extend(
        summarize_containers(
            pod.spec.init_containers,
            status.init_container_statuses if status is not None else None,
            "init",
        )
    )

    return PodSummary(
        uid=metadata.uid,
	    name=metadata.name,
        namespace=metadata.namespace,
        node_name=pod.spec.node_name,
        node_ip=status.host_ip if status is not None else None,
        pod_ip=status.pod_ip if status is not None else None,
        phase=(status.phase or "Unknown") if status is not None else "Unknown",
        ready=ready,
        deleting=metadata.deletion_timestamp is not None,
        owner_kind=owner.kind if owner is not None else None,
        owner_name=owner.name if owner is not None else None,
        created_at=metadata.creation_timestamp,
        containers=containers,
    )


def summarize_deployment(
    deployment: client.V1Deployment,
) -> DeploymentSummary:
    metadata = deployment.metadata
    spec = deployment.spec
    status = deployment.status

    return DeploymentSummary(
        uid=metadata.uid,
	    name=metadata.name,
        namespace=metadata.namespace,
        created_at=metadata.creation_timestamp,
        desired_replicas=(
            spec.replicas if spec.replicas is not None else 1
        ),
        ready_replicas=(
            (status.ready_replicas or 0) if status is not None else 0
        ),
        available_replicas=(
            (status.available_replicas or 0) if status is not None else 0
        ),
        updated_replicas=(
            (status.updated_replicas or 0) if status is not None else 0
        ),
        generation=metadata.generation,
        observed_generation=(
            status.observed_generation if status is not None else None
        ),
        images=[
            container.image
            for container in spec.template.spec.containers
        ],
    )


def controller_reference(
    metadata: client.V1ObjectMeta,
    kind: str,
) -> client.V1OwnerReference | None:
    """Return one supported controlling owner reference."""
    owners = [
        owner
        for owner in metadata.owner_references or []
        if owner.controller is True
    ]
    if len(owners) != 1:
        return None

    owner = owners[0]
    if (
        owner.api_version != "apps/v1"
        or owner.kind != kind
        or not owner.name
        or not owner.uid
    ):
        return None
    return owner

@router.get("/pods", response_model=PodsResponse)
def list_pods(
    request: Request,
    namespace: NamespaceFilter = None,
) -> PodsResponse:
    service = request.app.state.kubernetes
    core = service.core
    apps = client.AppsV1Api(service.api_client)

    if namespace is None:
        response = core.list_pod_for_all_namespaces(
            _request_timeout=REQUEST_TIMEOUT,
        )
        replica_sets = apps.list_replica_set_for_all_namespaces(
            _request_timeout=REQUEST_TIMEOUT,
        )
    else:
        response = core.list_namespaced_pod(
            namespace=namespace,
            _request_timeout=REQUEST_TIMEOUT,
        )
        replica_sets = apps.list_namespaced_replica_set(
            namespace=namespace,
            _request_timeout=REQUEST_TIMEOUT,
        )

    # Exact identities prevent matching a recreated ReplicaSet by name.
    deployment_owners = {
        (
            replica_set.metadata.namespace,
            replica_set.metadata.name,
            replica_set.metadata.uid,
        ): controller_reference(replica_set.metadata, "Deployment")
        for replica_set in replica_sets.items
        if replica_set.metadata is not None
    }

    pods = sorted(
        response.items,
        key=lambda pod: (pod.metadata.namespace, pod.metadata.name),
    )
    items = []

    for pod in pods:
        summary = summarize_pod(pod)
        replica_set_owner = controller_reference(pod.metadata, "ReplicaSet")
        deployment_owner = None

        if replica_set_owner is not None:
            deployment_owner = deployment_owners.get((
                pod.metadata.namespace,
                replica_set_owner.name,
                replica_set_owner.uid,
            ))

        if deployment_owner is not None:
            summary.owner_deployment_name = deployment_owner.name
            summary.owner_deployment_uid = deployment_owner.uid
        items.append(summary)

    return PodsResponse(items=items)


@router.get("/deployments", response_model=DeploymentsResponse)
def list_deployments(
    request: Request,
    namespace: NamespaceFilter = None,
) -> DeploymentsResponse:
    service = request.app.state.kubernetes
    apps = client.AppsV1Api(service.api_client)

    if namespace is None:
        response = apps.list_deployment_for_all_namespaces(
            _request_timeout=REQUEST_TIMEOUT,
        )
    else:
        response = apps.list_namespaced_deployment(
            namespace=namespace,
            _request_timeout=REQUEST_TIMEOUT,
        )

    deployments = sorted(
        response.items,
        key=lambda deployment: (
            deployment.metadata.namespace,
            deployment.metadata.name,
        ),
    )
    return DeploymentsResponse(
        items=[
            summarize_deployment(deployment)
            for deployment in deployments
        ],
    )
