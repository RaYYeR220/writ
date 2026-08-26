import { addressUrl, config } from '@/lib/config'

export function SiteFooter() {
  const registryLink = config.registry ? addressUrl(config.registry) : null

  return (
    <footer className="site">
      <div className="wrap">
        <span>
          Writ ⁄ 0G · {config.networkName} · chain id {config.chainId}
        </span>
        <span className="mono">
          {config.registry ? (
            registryLink ? (
              <a href={registryLink} target="_blank" rel="noreferrer">
                registry {config.registry}
              </a>
            ) : (
              `registry ${config.registry}`
            )
          ) : (
            'registry not configured'
          )}
        </span>
        <span>Attested decisions, recorded forever.</span>
      </div>
    </footer>
  )
}
