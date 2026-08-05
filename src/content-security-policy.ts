export function cockpitContentSecurityPolicy(allowApiKeyFallback: boolean): string {
  const connectSources = allowApiKeyFallback ? "'self' https://api.openai.com" : "'self'";
  return `default-src 'self'; connect-src ${connectSources}; media-src 'self' blob:; style-src 'self' 'unsafe-inline'`;
}
