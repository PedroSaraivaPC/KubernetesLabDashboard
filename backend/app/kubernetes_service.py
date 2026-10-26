"""Kubernetes connection and node queries."""

import os
from kubernetes import client, config
from app.models import NodeSummary

REQUEST_TIMEOUT = (3, 10)

class KubernetesService:
    def __init__(self) -> None:
        configuration = client.Configuration()
        mode = os.environ.get("KUBELAB_KUBE_MODE", "kubeconfig")

        if mode == "kubeconfig":
            kubeconfig = os.environ.get("KUBECONFIG")
            if not kubeconfig:
                raise RuntimeError(
                    "Set KUBECONFIG for local development."
                )

            config.load_kube_config(
                config_file=kubeconfig,
                client_configuration=configuration,
                persist_config=False,
            )
        elif mode == "incluster":
            config.load_incluster_config(
                client_configuration=configuration,
            )
        else:
            raise ValueError(
                "KUBELAB_KUBE_MODE must be kubeconfig or incluster."
            )

        configuration.retries = 0
        self.api_client = client.ApiClient(configuration=configuration)
        self.core = client.CoreV1Api(self.api_client)

    def close(self) -> None:
        self.api_client.close()

    def check_ready(self) -> None:
        self.core.list_node(
            limit=1,
            _request_timeout=REQUEST_TIMEOUT,
        )

    def list_nodes(self) -> list[NodeSummary]:
        response = self.core.list_node(
            _request_timeout=REQUEST_TIMEOUT,
        )
        nodes = sorted(
            response.items,
            key=lambda node: node.metadata.name,
        )
        return [summarize_node(node) for node in nodes]


def summarize_node(node: client.V1Node) -> NodeSummary:
    status = node.status
    ready = "Unknown"
    internal_ip = None
    node_info = None

    if status is not None:
        node_info = status.node_info

        for condition in status.conditions or []:
            if condition.type == "Ready":
                ready = condition.status
                break

        for address in status.addresses or []:
            if address.type == "InternalIP":
                internal_ip = address.address
                break

    labels = node.metadata.labels or {}

    return NodeSummary(
        name=node.metadata.name,
        ready=ready,
        internal_ip=internal_ip,
        kubelet_version=(
            node_info.kubelet_version if node_info else None
        ),
        container_runtime=(
            node_info.container_runtime_version if node_info else None
        ),
        is_control_plane=(
            "node-role.kubernetes.io/control-plane" in labels
        ),
    )
