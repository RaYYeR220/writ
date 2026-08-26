'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const LINKS = [
  { href: '/', label: 'The docket' },
  { href: '/studio', label: 'Studio' },
  { href: '/gate', label: 'Treasuries' },
  { href: '/about', label: 'How it works' },
] as const

export function Masthead() {
  const pathname = usePathname()

  return (
    <header className="mast">
      <div className="wrap">
        <Link href="/" className="wordmark cond">
          Writ<span> ⁄ 0G</span>
        </Link>
        <p className="tagline">A refusal is a receipt.</p>
        <nav className="views" aria-label="Sections">
          {LINKS.map((l) => {
            const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href)
            return (
              <Link key={l.href} href={l.href} aria-current={active ? 'page' : undefined}>
                {l.label}
              </Link>
            )
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  )
}

/**
 * Light and dark are both real here — the palette inverts what emits and what absorbs, it does
 * not lighten a dark page. Three states, because "follow the system" is a genuine preference
 * and overwriting it with a guess the first time someone clicks is rude.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')

  useEffect(() => {
    const stored = document.documentElement.getAttribute('data-theme')
    if (stored === 'dark' || stored === 'light') setTheme(stored)
  }, [])

  function cycle() {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
    setTheme(next)
    if (next === 'system') {
      document.documentElement.removeAttribute('data-theme')
      try {
        localStorage.removeItem('writ-theme')
      } catch {
        /* private mode; the page still works, the choice just will not persist */
      }
    } else {
      document.documentElement.setAttribute('data-theme', next)
      try {
        localStorage.setItem('writ-theme', next)
      } catch {
        /* as above */
      }
    }
  }

  const label = theme === 'system' ? 'Theme: auto' : theme === 'light' ? 'Theme: day' : 'Theme: dusk'

  return (
    <button className="ghost-btn cond" onClick={cycle} aria-label={`${label}. Click to change.`}>
      {label}
    </button>
  )
}
