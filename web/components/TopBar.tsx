export function TopBar() {
  return (
    <header className="topbar">
      <div className="brand">
        <span>CodeClone</span>
        <span className="badge">dashboard · v0.1</span>
      </div>
      <nav className="nav">
        <a href="/" className="active">overview</a>
        <a href="https://github.com/Sanjays2402/codeclone" target="_blank" rel="noreferrer">github</a>
      </nav>
    </header>
  );
}
