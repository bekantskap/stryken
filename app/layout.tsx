import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Edge — Stryktipset',
  description: 'Streck vs marknad, värdetabell och systemförslag',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>{children}</body>
    </html>
  )
}
