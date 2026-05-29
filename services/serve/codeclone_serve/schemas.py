"""OpenAI-compatible request/response models."""

from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, Field


Role = Literal["system", "user", "assistant", "tool"]


class ChatMessage(BaseModel):
    role: Role
    content: str
    name: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: float = 0.2
    top_p: float = 1.0
    max_tokens: int = 512
    stream: bool = False
    stop: list[str] | str | None = None
    n: int = 1
    user: str | None = None
    presence_penalty: float = 0.0
    frequency_penalty: float = 0.0


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatCompletionChoice(BaseModel):
    index: int
    message: ChatMessage
    finish_reason: str = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: list[ChatCompletionChoice]
    usage: Usage = Field(default_factory=Usage)


# ---- streaming chunks ----


class ChatCompletionDelta(BaseModel):
    role: Role | None = None
    content: str | None = None


class ChatCompletionStreamChoice(BaseModel):
    index: int
    delta: ChatCompletionDelta
    finish_reason: str | None = None


class ChatCompletionStreamChunk(BaseModel):
    id: str
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: list[ChatCompletionStreamChoice]


# ---- /v1/completions ----


class CompletionRequest(BaseModel):
    model: str
    prompt: str | list[str]
    temperature: float = 0.2
    top_p: float = 1.0
    max_tokens: int = 256
    stream: bool = False
    stop: list[str] | str | None = None
    n: int = 1
    suffix: str | None = None
    echo: bool = False
    user: str | None = None
    # Continue.dev FIM uses this when contextual tab-autocomplete is on
    fim_prefix: str | None = None
    fim_suffix: str | None = None


class CompletionChoice(BaseModel):
    text: str
    index: int = 0
    logprobs: dict | None = None
    finish_reason: str = "stop"


class CompletionResponse(BaseModel):
    id: str
    object: str = "text_completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: list[CompletionChoice]
    usage: Usage = Field(default_factory=Usage)


class ModelCard(BaseModel):
    id: str
    object: str = "model"
    created: int = Field(default_factory=lambda: int(time.time()))
    owned_by: str = "codeclone"


class ModelList(BaseModel):
    object: str = "list"
    data: list[ModelCard]
