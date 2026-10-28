# ADR-0003: AI provider is configuration — Anthropic API or Microsoft Foundry

- Status: Accepted (2026-10-28) · PRD: Part A, DEC-18

## Context
The owner may want Claude and speech services billed and managed through Microsoft Foundry (Azure). Claude models are available on Foundry at Anthropic's standard per-token rates via the Microsoft Marketplace; Foundry also hosts speech-to-text (Whisper / gpt-4o-transcribe, Azure AI Speech) and TTS.

## Decision
- `AI_PROVIDER=anthropic|foundry` selects the provider. The API constructs either `Anthropic` (`@anthropic-ai/sdk`) or `AnthropicFoundry` (`@anthropic-ai/foundry-sdk`) in one place; everything else uses the same Messages API surface.
- The runner's Claude Agent SDK reads the provider from its environment; verify the exact Foundry env vars against the Claude Code docs when ENG-05 lands.
- Models are chosen explicitly per versioned agent profile. No automatic "model router": cost, behaviour and audit must be predictable.
- P1 voice uses the `VoiceGateway`; Foundry speech is the default candidate when `AI_PROVIDER=foundry`.
- **Only a personal Azure subscription.** Employer tenants, keys or credits must not be used for this personal project (PRD §20 lesson 12, SEC-G06).

## Consequences
- No code fork; switching providers is an env change plus credentials in the vault.
- Some newest-API features can lag on Foundry; check platform availability before relying on one.
