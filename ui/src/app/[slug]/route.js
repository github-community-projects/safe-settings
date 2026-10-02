const { NextResponse } = require('next/server');

// JS version: no type annotations
export async function GET(request, context) {
  const { slug = '' } = await context.params;
  return NextResponse.json({ message: `Hello ${slug}!` });
}

export async function generateStaticParams() {
  // Replace with your actual slugs
  return [
    { slug: 'example1' },
    { slug: 'example2' }
  ];
}

export const dynamic = 'force-static';
