"""Public API response models."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class NodeSummary(BaseModel):
    name: str
    ready: Literal["True", "False", "Unknown"]
    internal_ip: str | None
    kubelet_version: str | None
    container_runtime: str | None
    is_control_plane: bool


class NodesResponse(BaseModel):
    items: list[NodeSummary]


class ContainerSummary(BaseModel):
    name: str
    kind: Literal["regular", "init"]
    image: str
    image_id: str | None
    ready: bool | None
    restart_count: int | None
    state: Literal["running", "waiting", "terminated", "unknown"]
    reason: str | None
    exit_code: int | None


class PodSummary(BaseModel):
    uid: str
    name: str
    namespace: str
    node_name: str | None
    node_ip: str | None
    pod_ip: str | None
    phase: Literal["Pending", "Running", "Succeeded", "Failed", "Unknown"]
    ready: Literal["True", "False", "Unknown"]
    deleting: bool
    owner_kind: str | None
    owner_name: str | None
    owner_deployment_name: str | None = None
    owner_deployment_uid: str | None = None
    created_at: datetime | None
    containers: list[ContainerSummary]


class PodsResponse(BaseModel):
    items: list[PodSummary]


class DeploymentSummary(BaseModel):
    uid: str
    name: str
    namespace: str
    created_at: datetime | None
    desired_replicas: int
    ready_replicas: int
    available_replicas: int
    updated_replicas: int
    generation: int | None
    observed_generation: int | None
    images: list[str]


class DeploymentsResponse(BaseModel):
    items: list[DeploymentSummary]
