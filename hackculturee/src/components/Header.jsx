export function Header() {
  return (
    <header className="header">
      <a className="brand" href="#top">
        <Logo />
        HackCulturee
      </a>
      <nav>
        <a href="#submit">Submit</a>
      </nav>
    </header>
  );
}

function Logo() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 7c7 2.2 9 6.2 9 9s-2 6.8-9 9" />
      <path d="M15 7c7 2.2 9 6.2 9 9s-2 6.8-9 9" />
    </svg>
  );
}
