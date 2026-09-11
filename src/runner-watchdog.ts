/** Trusted supervisor: the sandbox never receives its control stdin or credentials.
 * Parent pipe EOF (including a daemon crash) terminates the sandbox process group.
 * This does not claim to contain descendants that deliberately escape the group.
 */
export const watchdogProgram = String.raw`
const {spawn}=require('node:child_process');
let config='', child, timer, started=false, stopping=false;
function stop(){stopping=true;if(child&&child.pid){try{process.kill(-child.pid,'SIGKILL')}catch{}}}
process.stdin.setEncoding('utf8');
process.stdin.on('end',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.stdin.on('data',chunk=>{
 if(started)return;
 config+=chunk;
 if(config.length>1500000){process.exitCode=2;process.stdin.destroy();return;}
 if(!config.includes('\n'))return;
 started=true;
 try{
  const input=JSON.parse(config.slice(0,config.indexOf('\n')));config='';
  child=spawn('/usr/bin/sandbox-exec',['-p',input.profile,...input.argv],{
   cwd:input.cwd,env:input.env,detached:true,stdio:['ignore',1,2,...input.fds]
  });
  timer=setTimeout(stop,input.timeoutMs);
  child.once('error',()=>{clearTimeout(timer);process.exitCode=1;process.stdin.destroy();});
  child.once('close',(code,signal)=>{clearTimeout(timer);stop();if(signal)process.stderr.write('\nSandbox terminated: '+signal+'\n');process.exitCode=code===null?1:code;process.stdin.destroy();});
  if(stopping)stop();
 }catch{process.exitCode=2;process.stdin.destroy();}
});
`;
