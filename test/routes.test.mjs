import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {fixture} from './helpers.mjs';

test('configured API prefix works for translations and languages on any deployment host', async () => {
  const f=fixture();
  f.env.API_BASE_PATH='/api/v1';
  const r=await worker.fetch(new Request('https://own-worker.example.org/api/v1/translate', {
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text_list:['hello'],target_lang:'zh-CN'}),
  }),f.env);
  assert.equal(r.status,200);
  assert.equal((await worker.fetch(new Request('https://own-worker.example.org/api/v1/languages'),f.env)).status,200);
  assert.equal((await worker.fetch(new Request('https://own-worker.example.org/translate'),f.env)).status,404);
});

test('local HTTP works while public hosts redirect with path and query intact', async () => {
  const f=fixture();
  for(const host of ['localhost:8787','127.0.0.1:8787','[::1]:8787']) {
    assert.equal((await worker.fetch(new Request(`http://${host}/languages`),f.env)).status,200);
  }
  const r=await worker.fetch(new Request('http://own-worker.example.org:80/translate?a=1'),f.env);
  assert.equal(r.status,308);
  assert.equal(r.headers.get('location'),'https://own-worker.example.org/translate?a=1');
});

test('invalid API prefix fails explicitly', async () => {
  const f=fixture();
  f.env.API_BASE_PATH='/api/';
  assert.equal((await worker.fetch(new Request('https://example.org/translate'),f.env)).status,503);
});
