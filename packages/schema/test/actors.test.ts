import { describe, expect, it } from 'vitest';
import { ActorRefSchema, OwnerRefSchema } from '../src/actors.js';

describe('OwnerRefSchema', () => {
  it('accepts each known owner type', () => {
    for (const type of ['local', 'team', 'agent'] as const) {
      expect(OwnerRefSchema.parse({ type, id: 'x' })).toEqual({
        type,
        id: 'x',
      });
    }
  });

  it('accepts the v1 canonical owner', () => {
    expect(OwnerRefSchema.parse({ type: 'local', id: 'self' })).toEqual({
      type: 'local',
      id: 'self',
    });
  });

  it('rejects unknown owner types', () => {
    expect(() => OwnerRefSchema.parse({ type: 'organisation', id: 'acme' })).toThrow();
  });

  it('rejects empty or oversize ids', () => {
    expect(() => OwnerRefSchema.parse({ type: 'local', id: '' })).toThrow();
    expect(() => OwnerRefSchema.parse({ type: 'team', id: 'a'.repeat(129) })).toThrow();
  });

  it('rejects extra properties (strict object)', () => {
    expect(() =>
      OwnerRefSchema.parse({
        type: 'local',
        id: 'self',
        extra: true,
      } as unknown),
    ).toThrow();
  });
});

describe('ActorRefSchema', () => {
  it('accepts a bare cli actor', () => {
    expect(ActorRefSchema.parse({ type: 'cli' })).toEqual({ type: 'cli' });
  });

  it('accepts a bare system actor', () => {
    expect(ActorRefSchema.parse({ type: 'system' })).toEqual({
      type: 'system',
    });
  });

  it('accepts an mcp actor with an agent identifier', () => {
    expect(ActorRefSchema.parse({ type: 'mcp', agent: 'claude-code/0.5.0' })).toEqual({
      type: 'mcp',
      agent: 'claude-code/0.5.0',
    });
  });

  it('accepts a scheduler actor with a job name', () => {
    expect(ActorRefSchema.parse({ type: 'scheduler', job: 'decay' })).toEqual({
      type: 'scheduler',
      job: 'decay',
    });
  });

  it('rejects mcp actors missing the agent field', () => {
    expect(() => ActorRefSchema.parse({ type: 'mcp' })).toThrow();
  });

  it('rejects scheduler actors missing the job field', () => {
    expect(() => ActorRefSchema.parse({ type: 'scheduler' })).toThrow();
  });

  it('rejects extra properties on bare variants', () => {
    expect(() => ActorRefSchema.parse({ type: 'cli', extra: 1 } as unknown)).toThrow();
    expect(() => ActorRefSchema.parse({ type: 'system', extra: 1 } as unknown)).toThrow();
  });

  it('rejects unknown actor types', () => {
    expect(() => ActorRefSchema.parse({ type: 'webhook' } as unknown)).toThrow();
  });
});
