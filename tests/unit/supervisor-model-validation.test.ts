import { describe, expect, it } from 'vitest';
import {
  buildSupervisorModelValidationArgs,
  conciseSupervisorModelValidationOutput,
  parseCodexModelCache,
  parseGrokConfiguredModels,
  parseKimiProviderModelList,
  parsePiModelList,
} from '../../src/main/supervisor-model-validation';

describe('supervisor model validation invocation', () => {
  it('uses ephemeral, read-only Codex execution', () => {
    const args = buildSupervisorModelValidationArgs('codex', 'gpt-next');

    expect(args).toContain('exec');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('read-only');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-next']);
  });

  it('uses a no-session Pi request with tools and project context disabled', () => {
    const args = buildSupervisorModelValidationArgs('pi', 'vendor/model');

    expect(args).toContain('--print');
    expect(args).toContain('--no-session');
    expect(args).toContain('--no-tools');
    expect(args).toContain('--no-context-files');
  });

  it('uses single-turn modes for Kimi and Grok', () => {
    expect(buildSupervisorModelValidationArgs('kimi', 'k-next')).toContain('--prompt');
    expect(buildSupervisorModelValidationArgs('grok', 'grok-next')).toContain('--single');
    expect(buildSupervisorModelValidationArgs('grok', 'grok-next')).toContain('--no-memory');
  });

  it('omits the model flag when validating the Agent default', () => {
    expect(buildSupervisorModelValidationArgs('pi', '')).not.toContain('--model');
  });

  it('redacts account identifiers and common API keys from provider errors', () => {
    const output = conciseSupervisorModelValidationOutput(
      'team 02a7de79-cd14-43a2-a4d4-b78973cf96d6 key sk-secret_value_123456',
    );

    expect(output).toBe('team [已隐藏标识] key [已隐藏凭据]');
  });

  it('parses the Pi model table into provider-qualified IDs', () => {
    expect(parsePiModelList([
      'provider      model          context  max-out',
      'xai           grok-4.6       500K     500K     yes       yes',
      'openai-codex  gpt-5.6-terra  400K     128K     yes       yes',
      'Warning: this is not a model row',
    ].join('\n'))).toEqual(['openai-codex/gpt-5.6-terra', 'xai/grok-4.6']);
  });

  it('parses configured Kimi model aliases', () => {
    expect(parseKimiProviderModelList(JSON.stringify({
      models: {
        'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3' },
        'kimi-code/k3-256k': { provider: 'managed:kimi-code', model: 'k3-256k' },
      },
    }))).toEqual(['k3', 'k3-256k']);
  });

  it('parses Codex cached models and ignores malformed entries', () => {
    expect(parseCodexModelCache(JSON.stringify({
      models: [{ slug: 'gpt-5.6-terra' }, { id: 'gpt-5.5' }, { name: 'invalid model' }],
    }))).toEqual(['gpt-5.5', 'gpt-5.6-terra']);
  });

  it('reads configured Grok models without treating reasoning effort as a model', () => {
    expect(parseGrokConfiguredModels([
      '[models]',
      'default = "grok-4.6"',
      'default_reasoning_effort = "medium"',
    ].join('\n'))).toEqual(['grok-4.6']);
  });
});
