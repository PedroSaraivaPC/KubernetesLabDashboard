"""KubeLab HTTP API."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from kubernetes.client.exceptions import ApiException
from urllib3.exceptions import HTTPError as KubernetesConnectionError

from app.kubernetes_service import KubernetesService
from app.models import NodesResponse
from app.workloads import router as workloads_router

from app.actions import router as actions_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    service = KubernetesService()
    app.state.kubernetes = service

    try:
        yield
    finally:
        service.close()


app = FastAPI(
    title="KubeLab API",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(workloads_router)
app.include_router(actions_router)

@app.exception_handler(ApiException)
async def handle_kubernetes_api_error(
    _request: Request,
    error: ApiException,
) -> JSONResponse:
    if error.status in (401, 403):
        detail = "Kubernetes API access denied."
    else:
        detail = "Kubernetes API request failed."

    return JSONResponse(
        status_code=503,
        content={"detail": detail},
    )


@app.exception_handler(KubernetesConnectionError)
async def handle_kubernetes_connection_error(
    _request: Request,
    _error: KubernetesConnectionError,
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": "Cannot reach the Kubernetes API."},
    )


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def ready(request: Request) -> dict[str, str]:
    request.app.state.kubernetes.check_ready()
    return {"status": "ready"}


@app.get("/api/nodes", response_model=NodesResponse)
def list_nodes(request: Request) -> NodesResponse:
    nodes = request.app.state.kubernetes.list_nodes()
    return NodesResponse(items=nodes)


if os.environ.get("KUBELAB_SERVE_FRONTEND") == "1":
    frontend_dir = Path(__file__).resolve().parents[2] / "frontend"
    app.mount(
        "/",
        StaticFiles(directory=frontend_dir, html=True),
        name="frontend",
    )
