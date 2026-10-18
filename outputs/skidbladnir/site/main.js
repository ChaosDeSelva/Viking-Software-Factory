const frames = [
  ['REQUESTED','01 / PROVISION WITH INTENT','Give every worker a purpose.','Choose an environment and a maximum lifetime before launching. The local simulator records the request and its resulting state.','worker.requested → purpose and lifetime recorded'],
  ['RUNNING','02 / FOLLOW THE EVIDENCE','Know where the work stands.','Inspect lifecycle events as they arrive. The local app persists simulated worker state and history, so a restart does not erase the record.','worker.running → lifecycle event recorded'],
  ['TERMINATED','03 / RETIRE DELIBERATELY','Fold the fleet away.','Terminate the simulated worker and retain its history. Real cloud cleanup and artifact collection remain planned capabilities.','worker.terminated → history retained']
];
for (const button of document.querySelectorAll('[data-step]')) button.addEventListener('click',()=>{
  document.querySelectorAll('[data-step]').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button));});
  const values=frames[Number(button.dataset.step)];
  ['demo-status','demo-label','demo-title','demo-description','demo-log'].forEach((id,index)=>document.getElementById(id).textContent=values[index]);
});
document.getElementById('copy').addEventListener('click',async()=>{
  const status=document.getElementById('copy-status');
  try { await navigator.clipboard.writeText(document.getElementById('commands').textContent); status.textContent='Commands copied.'; }
  catch { status.textContent='Clipboard unavailable. Select and copy the commands above.'; }
});
