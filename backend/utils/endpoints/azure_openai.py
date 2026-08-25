import json
import time
from typing import Any, Dict, List, Optional

import requests

from utils.exceptions import TranslationError, ValidationError
from utils.logging import log_message
from utils.model_metadata import is_gpt5_series

# Azure OpenAI API version to use when the endpoint URL doesn't specify one.
# Override with the AZURE_OPENAI_API_VERSION env var for newer model support.
DEFAULT_AZURE_OPENAI_API_VERSION = "2025-04-01-preview"


def call_azure_openai_endpoint(
    endpoint: str,
    deployment: str,
    api_key: str,
    parts: List[Dict[str, Any]],
    generation_config: Dict[str, Any],
    api_version: Optional[str] = None,
    system_prompt: Optional[str] = None,
    debug: bool = False,
    timeout: int = 120,
    max_retries: int = 3,
    base_delay: float = 1.0,
) -> Optional[str]:
    """
    Calls an Azure OpenAI Chat Completions deployment and handles retries.

    Unlike the public OpenAI API, Azure OpenAI identifies the model via a
    per-resource "deployment" in the URL and authenticates with an `api-key`
    header rather than `Authorization: Bearer`.

    Args:
        endpoint (str): Azure resource endpoint, e.g. "https://my-resource.openai.azure.com".
        deployment (str): Azure deployment name (the model is fixed at deployment time).
        api_key (str): Azure OpenAI API key.
        parts (List[Dict[str, Any]]): List of content parts (text, images).
        generation_config (Dict[str, Any]): temperature/top_p/max_tokens/image_detail/
                                            reasoning_effort/verbosity.
        api_version (Optional[str]): Azure API version; defaults to DEFAULT_AZURE_OPENAI_API_VERSION.
        debug (bool): Whether to print debugging information.
        timeout (int): Request timeout in seconds.
        max_retries (int): Maximum number of retries for rate limiting errors.
        base_delay (float): Initial delay for retries in seconds.

    Returns:
        Optional[str]: The raw text content from the API response if successful,
                       None if blocked by content filter or if no content is found after retries.

    Raises:
        ValidationError: If endpoint/deployment/api_key is missing or parts format is invalid.
        TranslationError: If the API call fails after retries or response processing fails.
    """
    if not endpoint:
        raise ValidationError("Endpoint is required for Azure OpenAI")
    if not deployment:
        raise ValidationError("Deployment name is required for Azure OpenAI")
    if not api_key:
        raise ValidationError("API key is required for Azure OpenAI")
    text_part = next((p for p in parts if "text" in p), None)
    image_parts = [p for p in parts if "inline_data" in p]
    if not text_part:
        raise ValidationError(
            "Invalid 'parts' format for Azure OpenAI: No text prompt found."
        )

    resolved_api_version = api_version or DEFAULT_AZURE_OPENAI_API_VERSION
    url = (
        f"{endpoint.rstrip('/')}/openai/deployments/{deployment}/chat/completions"
        f"?api-version={resolved_api_version}"
    )
    headers = {"api-key": api_key, "Content-Type": "application/json"}

    image_detail = generation_config.get("image_detail")
    user_content = []
    for part in image_parts:
        if (
            "inline_data" in part
            and "data" in part["inline_data"]
            and "mime_type" in part["inline_data"]
        ):
            mime_type = part["inline_data"]["mime_type"]
            base64_image = part["inline_data"]["data"]
            image_url: Dict[str, Any] = {
                "url": f"data:{mime_type};base64,{base64_image}"
            }
            if image_detail:
                image_url["detail"] = image_detail
            user_content.append({"type": "image_url", "image_url": image_url})
        else:
            log_message(f"Invalid image part format: {part}", always_print=True)
    user_content.append({"type": "text", "text": text_part["text"]})

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_content})

    payload: Dict[str, Any] = {"messages": messages}

    lower_deployment = (deployment or "").lower()
    is_gpt5 = is_gpt5_series(deployment)
    is_chat_variant = "chat" in lower_deployment
    is_reasoning_capable = (
        is_gpt5
        or lower_deployment.startswith("o1")
        or lower_deployment.startswith("o3")
        or lower_deployment.startswith("o4-mini")
    )

    max_tokens_value = generation_config.get("max_tokens", 4096)
    if is_reasoning_capable and not is_chat_variant:
        # Reasoning-capable deployments (o1/o3/o4-mini/GPT-5 series) require
        # max_completion_tokens and reject non-default temperature/top_p.
        payload["max_completion_tokens"] = max_tokens_value

        effort = generation_config.get("reasoning_effort")
        if effort and effort != "none":
            effort_to_send = "high" if effort == "xhigh" else effort
            if effort_to_send == "minimal" and not is_gpt5:
                effort_to_send = "low"
            payload["reasoning_effort"] = effort_to_send

        if is_gpt5:
            payload["verbosity"] = generation_config.get("verbosity", "low")
    else:
        payload["max_tokens"] = max_tokens_value
        temp = generation_config.get("temperature")
        if temp is not None:
            payload["temperature"] = temp
        top_p = generation_config.get("top_p")
        if top_p is not None:
            payload["top_p"] = top_p

    for attempt in range(max_retries + 1):
        current_delay = min(base_delay * (2**attempt), 16.0)
        try:
            log_message(
                f"Azure OpenAI API request to deployment '{deployment}' "
                f"(attempt {attempt + 1}/{max_retries + 1})",
                verbose=debug,
            )

            response = requests.post(
                url, headers=headers, json=payload, timeout=timeout
            )
            response.raise_for_status()

            log_message("Processing Azure OpenAI response", verbose=debug)
            try:
                result = response.json()

                if "choices" in result and len(result["choices"]) > 0:
                    choice = result["choices"][0]
                    finish_reason = choice.get("finish_reason")

                    message = choice.get("message")
                    if message and "content" in message:
                        content = message["content"]
                        return content.strip() if content else ""
                    else:
                        log_message(
                            f"No message content in response. Finish reason: {finish_reason}",
                            always_print=True,
                        )
                        log_message(
                            f"Full response: {json.dumps(result, indent=2)}",
                            verbose=debug,
                        )
                        return ""
                else:
                    log_message(
                        "No choices in Azure OpenAI response", always_print=True
                    )
                    if "error" in result:
                        error_msg = result.get("error", {}).get(
                            "message", "Unknown error"
                        )
                        raise TranslationError(
                            f"Azure OpenAI API returned error: {error_msg}"
                        )
                    return None

            except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
                raise TranslationError(
                    f"Error processing successful Azure OpenAI API response: {str(e)}"
                ) from e

        except requests.exceptions.HTTPError as e:
            status_code = e.response.status_code
            error_text = e.response.text[:500]

            if status_code == 429 and attempt < max_retries:
                log_message(
                    f"Rate limited, retrying in {current_delay:.1f}s", verbose=debug
                )
                time.sleep(current_delay)
                continue
            else:
                error_reason = f"Status {status_code}: {error_text}"
                if status_code == 429 and attempt == max_retries:
                    error_reason = (
                        f"Rate limited after {max_retries + 1} attempts: {error_text}"
                    )
                elif status_code == 400:
                    error_reason += " (Check payload/deployment name/api-version)"
                elif status_code == 401:
                    error_reason += " (Check API key)"
                elif status_code == 404:
                    error_reason += " (Check endpoint and deployment name)"

                raise TranslationError(
                    f"Azure OpenAI API HTTP Error: {error_reason}"
                ) from e

        except requests.exceptions.RequestException as e:
            if attempt < max_retries:
                log_message(
                    f"Connection error, retrying in {current_delay:.1f}s: {str(e)}",
                    verbose=debug,
                )
                time.sleep(current_delay)
                continue
            else:
                raise TranslationError(
                    f"Azure OpenAI API Connection Error after retries: {str(e)}"
                ) from e

    raise TranslationError(
        f"Failed to get response from Azure OpenAI deployment '{deployment}' "
        f"after {max_retries + 1} attempts."
    )
