import type { Metadata, Viewport } from 'next'
import { Newsreader, Saira_Condensed } from 'next/font/google'
import { Masthead } from '@/components/Masthead'
import { SiteFooter } from '@/components/SiteFooter'
import './globals.css'

const cond = Saira_Condensed({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-cond',
  display: 'swap',
})

const body = Newsreader({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-body',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Writ — attested decisions, held and released',
  description:
    'A public record of AI decisions verified inside a smart contract on 0G. Every refusal is a transaction, recorded permanently and checkable by anyone.',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f0e8' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0b09' },
  ],
}

/**
 * Applied before first paint so a reader who chose a theme never sees the other one flash.
 * Inline because a stylesheet cannot read localStorage and a component cannot run early enough.
 */
const THEME_BOOT = `try{var t=localStorage.getItem('writ-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${cond.variable} ${body.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Masthead />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  )
}
