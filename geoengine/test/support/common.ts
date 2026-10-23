export const until = async (predicate: () => boolean | Promise<boolean>, ms: number, what: string) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
