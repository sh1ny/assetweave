<script lang="ts">
  type Connection = { origin: string; profile: string };
  type Session = { authenticated: true; csrfToken: string };
  let connection = $state<Connection | null>(null);
  let session = $state<Session | null>(null);
  let pairingCode = $state('');
  let busy = $state(false);
  let message = $state('');

  async function refresh() {
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        session = null;
        connection = null;
        if (response.status !== 401) message = 'The local service could not check your session. Try again.';
        return;
      }
      session = (await response.json()) as Session;
      const info = await fetch('/api/connection', { credentials: 'same-origin', cache: 'no-store' });
      if (!info.ok) throw new Error('connection unavailable');
      connection = (await info.json()) as Connection;
      message = '';
    } catch {
      session = null;
      connection = null;
      message = 'Cannot reach the local service. Start it from the project terminal, then reload this page.';
    }
  }

  async function pair(event: SubmitEvent) {
    event.preventDefault();
    if (!pairingCode.trim() || busy) return;
    busy = true;
    message = '';
    try {
      const response = await fetch('/api/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: pairingCode.trim() })
      });
      if (!response.ok) {
        message = response.status === 401
          ? 'Code rejected or expired. Request a new one in the terminal and try again.'
          : 'Could not pair with the local service. Check the terminal and try again.';
        return;
      }
      pairingCode = '';
      await refresh();
    } catch {
      message = 'Cannot reach the local service. Start it from the project terminal, then try again.';
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    if (!session || busy) return;
    busy = true;
    try {
      const response = await fetch('/api/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'x-assetweave-csrf': session.csrfToken }
      });
      if (!response.ok) throw new Error('sign-out failed');
      session = null;
      connection = null;
      message = '';
    } catch {
      message = 'Could not end this browser session. Try again.';
    } finally {
      busy = false;
    }
  }

  void refresh();
</script>

<svelte:head>
  <meta name="description" content="Connect this browser to your private local AssetWeave service." />
</svelte:head>

<div class="frame">
  <header class="topbar">
    <div class="brand"><span class="mark" aria-hidden="true">A<span>·</span>W</span><span>AssetWeave</span></div>
    <span class="environment"><span class="environment-dot"></span> LOCAL WORKSPACE</span>
  </header>
  <main>
    <p class="eyebrow">YOUR ARTWORK, YOUR MACHINE <span>—</span> 01 / CONNECTION</p>
    {#if session && connection}
      <section class="panel" aria-labelledby="connected-title">
        <div class="panel-top"><span class="status"><span class="status-light"></span> CONNECTED</span><span class="panel-id">BROWSER SESSION</span></div>
        <h1 id="connected-title">A private workspace,<br /><em>ready when you are.</em></h1>
        <p class="intro">This browser is paired with the independently running local service. Closing this tab will not stop the service.</p>
        <div class="connection-details">
          <div><span class="label">SERVICE ORIGIN</span><code>{connection.origin}</code></div>
          <div><span class="label">LOCAL PROFILE</span><code>{connection.profile}</code></div>
        </div>
        <button class="secondary" type="button" onclick={disconnect} disabled={busy}>End browser session <span aria-hidden="true">↗</span></button>
      </section>
    {:else}
      <section class="panel" aria-labelledby="pair-title">
        <div class="panel-top"><span class="status pending"><span class="status-light"></span> NOT PAIRED</span><span class="panel-id">LOCAL ACCESS</span></div>
        <h1 id="pair-title">Keep your work<br /><em>close to home.</em></h1>
        <p class="intro">Pair this browser with the local service. Your artwork and records stay in a private profile on this machine; no cloud account is needed.</p>
        <div class="instructions"><span class="step">01</span><p>Start the service with <code>corepack pnpm start</code> in a terminal.</p></div>
        <div class="instructions"><span class="step">02</span><p>In another interactive terminal, run <code>corepack pnpm pair</code> and request a one-time code.</p></div>
        <form onsubmit={pair}>
          <label for="pair-code">ONE-TIME PAIRING CODE</label>
          <div class="input-row"><input id="pair-code" name="pair-code" type="password" autocomplete="off" spellcheck="false" bind:value={pairingCode} placeholder="Paste the code from your terminal" required /><button type="submit" disabled={busy || !pairingCode.trim()}>Pair browser <span aria-hidden="true">↗</span></button></div>
        </form>
      </section>
    {/if}
    {#if message}<p class="notice" role="alert">{message}</p>{/if}
    <footer><span>LOCAL FIRST, BY DESIGN.</span><span>ASSETWEAVE / PRIVATE CONNECTION</span></footer>
  </main>
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #111b20; color: #edf1e9; font-family: 'Segoe UI', Inter, system-ui, sans-serif; }
  :global(button), :global(input) { font: inherit; }
  :global(button:focus-visible), :global(input:focus-visible) { outline: 2px solid #edbd78; outline-offset: 3px; }
  .frame { min-height: 100vh; background: radial-gradient(ellipse 55% 75% at 85% 85%, #1b3734 0%, transparent 82%), #111b20; }
  .topbar { max-width: 1280px; margin: auto; padding: 33px 48px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #334147; }
  .brand { display: flex; align-items: center; gap: 13px; font-weight: 650; letter-spacing: -.025em; font-size: 18px; }
  .mark { width: 39px; height: 39px; border: 1px solid #cfaa77; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-family: Georgia, serif; font-size: 15px; color: #f3c995; letter-spacing: -.11em; padding-right: 3px; }
  .mark span { color: #ad9a7e; padding: 0 2px; }
  .environment, .eyebrow, .panel-id, .status, .label, form label, .step, footer { font-size: 11px; font-weight: 700; letter-spacing: .16em; }
  .environment { display: flex; align-items: center; gap: 11px; color: #abb8b5; }
  .environment-dot, .status-light { width: 6px; height: 6px; background: #a5d5ad; display: inline-block; border-radius: 50%; }
  main { max-width: 1000px; margin: 0 auto; padding: clamp(60px, 9vw, 124px) 32px 28px; }
  .eyebrow { color: #c2a075; margin: 0 0 23px 3px; }
  .eyebrow span { color: #697a78; padding: 0 6px; }
  .panel { padding: clamp(28px, 5.4vw, 68px); border: 1px solid #465555; border-radius: 10px; background: #19262a; box-shadow: 0 24px 80px #07131366; }
  .panel-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .status { display: flex; align-items: center; gap: 10px; color: #a5d5ad; }
  .status.pending { color: #edbd78; }
  .status.pending .status-light { background: #edbd78; }
  .panel-id { color: #829592; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: clamp(41px, 6vw, 69px); letter-spacing: -.052em; line-height: 1.08; margin: 36px 0 22px; }
  h1 em { font-weight: 400; color: #edbd78; }
  .intro { max-width: 610px; font-size: 16px; line-height: 1.7; color: #b9c5c1; margin: 0 0 35px; }
  .instructions { border-top: 1px solid #354549; padding: 14px 0; display: flex; gap: 21px; align-items: baseline; }
  .instructions p { margin: 0; color: #d4ddd6; font-size: 14px; line-height: 1.6; }
  .step { color: #edbd78; }
  code { font-family: Consolas, 'Cascadia Code', monospace; font-size: .92em; overflow-wrap: anywhere; }
  .instructions code { color: #edbd78; }
  form { border-top: 1px solid #354549; padding-top: 27px; margin-top: 4px; }
  form label, .label { display: block; color: #b4c6bf; margin-bottom: 12px; }
  .input-row { display: flex; gap: 10px; }
  input { min-width: 0; flex: 1; height: 51px; background: #101a1e; color: #fff; border: 1px solid #576765; border-radius: 5px; padding: 0 15px; }
  input::placeholder { color: #90a09c; }
  button { cursor: pointer; border: 1px solid #edbd78; border-radius: 5px; background: #edbd78; color: #162321; padding: 0 20px; height: 51px; font-size: 13px; font-weight: 700; white-space: nowrap; }
  button span { padding-left: 12px; }
  button:disabled { opacity: .48; cursor: not-allowed; }
  button.secondary { margin-top: 23px; color: #edbd78; background: transparent; }
  .connection-details { border-top: 1px solid #354549; }
  .connection-details > div { border-bottom: 1px solid #354549; display: flex; gap: 20px; justify-content: space-between; padding: 20px 0; }
  .connection-details .label { margin: 0; white-space: nowrap; }
  .connection-details code { color: #edf1e9; text-align: right; }
  .notice { color: #f3c5a8; background: #412d2b; border: 1px solid #a86953; border-radius: 5px; padding: 14px 16px; line-height: 1.4; }
  footer { display: flex; justify-content: space-between; gap: 16px; color: #859993; margin-top: 30px; }
  @media (max-width: 620px) { .topbar { padding: 20px; } .environment { font-size: 0; } .environment-dot { width: 8px; height: 8px; } main { padding: 64px 18px 28px; } .eyebrow { font-size: 10px; } .panel { padding: 27px 23px; } .panel-id { font-size: 9px; } h1 { margin-top: 27px; } .input-row, .connection-details > div { flex-direction: column; } .input-row button { width: 100%; } .connection-details code { text-align: left; } footer { flex-direction: column; line-height: 1.5; } }
  @media (max-width: 620px) { .input-row input { flex: none; width: 100%; } }
</style>
