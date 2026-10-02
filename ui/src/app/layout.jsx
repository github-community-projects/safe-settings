import './globals.css';
import { ThemeProvider } from './components/ThemeContext';

// (Optional) Next.js App Router metadata API – safe to add
export const metadata = {
  title: 'Safe Settings',
  description: 'Safe Settings dashboard',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: 'any' }
    ],
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon.ico'
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Existing Bootstrap CSS */}
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
          rel="stylesheet"
        />
        {/* Favicon / icons */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        {/* Optional apple-touch-icon (provide file or remove link) */}
        {/* <link rel="apple-touch-icon" href="/apple-touch-icon.png" /> */}
        <meta name="theme-color" content="#0d1117" />
      </head>
      <body suppressHydrationWarning={true}>
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}