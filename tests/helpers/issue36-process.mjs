export async function stopIssue36Server(child, done, ended, graceMs = 7000) {
  if (ended) return done;
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    if (child.connected) child.send({type:'shutdown'}, () => {});
    return await done;
  } finally {
    clearTimeout(timer);
  }
}
