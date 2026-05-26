import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from './detect';

const base = { totalRamGb: 16, ollamaModels: ['qwen2.5:7b', 'qwen2.5:3b'], override: null as string | null, cloud: { enabled: false, model: '' } };

test('override off → off', () => {
  assert.equal(chooseModel({ ...base, override: 'off' }).kind, 'off');
});
test('override cloud with config → cloud', () => {
  assert.equal(chooseModel({ ...base, override: 'cloud', cloud: { enabled: true, model: 'gpt' } }).kind, 'cloud');
});
test('override cloud without config → off', () => {
  assert.equal(chooseModel({ ...base, override: 'cloud' }).kind, 'off');
});
test('explicit ollama model override', () => {
  const m = chooseModel({ ...base, override: 'llama3.2:3b' });
  assert.equal(m.kind, 'ollama');
  assert.equal(m.model, 'llama3.2:3b');
});
test('auto: cloud opt-in wins when configured', () => {
  assert.equal(chooseModel({ ...base, cloud: { enabled: true, model: 'gpt' } }).kind, 'cloud');
});
test('auto: no ollama models → off', () => {
  assert.equal(chooseModel({ ...base, ollamaModels: [] }).kind, 'off');
});
test('auto: 16GB + 7b available → 7b', () => {
  assert.equal(chooseModel({ ...base }).model, 'qwen2.5:7b');
});
test('auto: 8GB → small model', () => {
  assert.equal(chooseModel({ ...base, totalRamGb: 8 }).model, 'qwen2.5:3b');
});
test('auto: <8GB → off', () => {
  assert.equal(chooseModel({ ...base, totalRamGb: 4 }).kind, 'off');
});
