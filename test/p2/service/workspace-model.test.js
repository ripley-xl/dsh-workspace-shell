import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from '../../p1/service/helpers.mjs';

test('connect ignores legacy local workspace and uses the remote host default', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({
    hostAlias: 'p0-test', defaultWorkspace: '/local/must/not/override', syncPolicy: { appearance: false },
  });
  let options;
  const open = fixture.service.openRemoteHost;
  fixture.service.openRemoteHost = async (input) => {
    options = input;
    return open(input);
  };
  await fixture.service.connect(record.id);
  assert.equal(Object.hasOwn(options, 'workspace'), false);
  assert.equal(fixture.service.runtime(record.id).host.workspace, '/home/test');
  assert.equal('defaultWorkspace' in fixture.store.get(record.id), false);
});
