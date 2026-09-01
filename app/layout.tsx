import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Edge — Stryktipset & Europatipset',
  description: 'Streck vs marknad, värdetabell och systemförslag',
  icons: { icon: '/favicon.svg' },
  // Privat analysverktyg — ska inte hamna i sökresultat.
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  )
}
