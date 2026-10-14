export function cockpitContentSecurityPolicy(): string {
  const connectSources = "'self' https://api.openai.com";
  return `default-src 'self'; connect-src ${connectSources}; media-src 'self' blob:; style-src 'self' 'unsafe-inline'`;
}
