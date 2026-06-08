"use client";

export default function NotFound() {
  return (
    <main className="card p-6 lg:p-10">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-[color:var(--muted)]">404</div>
        <h1 className="text-2xl font-semibold">
          <span className="bg-clip-text text-transparent bg-gradient-to-r from-[color:var(--accent)] to-[color:var(--accent2)]">
            Page not found
          </span>
        </h1>
        <p className="text-sm text-[color:var(--muted)]">
          The page you’re looking for doesn’t exist.
        </p>
        <a className="btn btn-primary inline-flex" href="/">
          Go home
        </a>
      </div>
    </main>
  );
}

