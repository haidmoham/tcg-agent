import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeAtomicJson} from '../scripts/model7-atomic-json.mjs';

test('atomic status replacement survives a temporary Windows reader sharing lock', {skip:process.platform!=='win32'}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'model7-status-')),file=path.join(directory,'status.json');
  fs.writeFileSync(file,JSON.stringify({version:1}));
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    "$stream=[IO.File]::Open($env:MODEL7_TEST_STATUS,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); Write-Output 'LOCKED'; Start-Sleep -Milliseconds 400; $stream.Dispose()"],
    {windowsHide:true,env:{...process.env,MODEL7_TEST_STATUS:file},stdio:['ignore','pipe','pipe']});
  try {
    const [data]=await once(child.stdout,'data');assert.match(String(data),/LOCKED/);
    const begin=performance.now();writeAtomicJson(file,{version:2,complete:true});
    assert(performance.now()-begin>=150,'the write must encounter the live reader lock');
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),{version:2,complete:true});
    assert.equal(fs.readdirSync(directory).length,1);
  } finally {child.kill();fs.rmSync(directory,{recursive:true,force:true});}
});
