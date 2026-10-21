import fs from 'node:fs';

export function writeAtomicJson(file,value) {
  const temporary=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n');
  const pause=new Int32Array(new SharedArrayBuffer(4));
  for(let attempt=0;;attempt++) {
    try {fs.renameSync(temporary,file);return;}
    catch(error) {
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=79)throw error;
      Atomics.wait(pause,0,0,25);
    }
  }
}
