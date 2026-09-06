type LiveEnvironment = Readonly<Record<string, string | undefined>>

export const isLiveTestEnabled = (environment: LiveEnvironment, flagName: string): boolean =>
  environment[flagName] === '1'

export const runCredentialedLiveEntry = async (
  environment: LiveEnvironment,
  flagName: string,
  credentialName: string,
  enter: (credential: string) => Promise<unknown>
): Promise<'skipped' | 'ran'> => {
  if (!isLiveTestEnabled(environment, flagName)) return 'skipped'

  const credential = environment[credentialName]
  if (credential === undefined || credential.trim() === '') {
    throw new Error(`${flagName}=1 requires a non-empty ${credentialName}`)
  }

  await enter(credential)
  return 'ran'
}
