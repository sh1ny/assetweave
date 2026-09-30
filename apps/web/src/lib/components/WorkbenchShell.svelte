<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Snippet } from 'svelte';

  type Theme = 'dark' | 'light';
  type Props = {
    navigation: Snippet;
    content: Snippet;
    inspector: Snippet;
    title: string;
    context: string;
    onRefresh: () => void;
    onDisconnect: () => void;
    onCapture?: () => void;
  };

  let { navigation, content, inspector, title, context, onRefresh, onDisconnect, onCapture }: Props = $props();
  let theme = $state<Theme | null>(null);
  let explicitPreference = false;
  let narrow = $state(false);
  let drawerOpen = $state(false);
  let inspectorExpanded = $state(false);
  let drawerButton: HTMLButtonElement;
  let closeButton: HTMLButtonElement;
  let navigationPanel: HTMLElement;

  onMount(() => {
    const width = window.matchMedia('(max-width: 900px)');
    const color = window.matchMedia('(prefers-color-scheme: dark)');
    try {
      const stored = localStorage.getItem('assetweave-theme');
      if (stored === 'dark' || stored === 'light') {
        explicitPreference = true;
        theme = stored;
      }
    } catch {
      // A disabled storage API does not prevent local theme switching.
    }
    if (!explicitPreference) theme = color.matches ? 'dark' : 'light';
    narrow = width.matches;
    const onColorChange = (event: MediaQueryListEvent) => {
      if (!explicitPreference) theme = event.matches ? 'dark' : 'light';
    };
    const onWidthChange = async (event: MediaQueryListEvent) => {
      const focused = document.activeElement;
      const focusNavigation = !event.matches && (focused === drawerButton || (drawerOpen && focused === closeButton));
      const focusMenu = event.matches && !drawerOpen && navigationPanel.contains(focused);
      narrow = event.matches;
      if (!event.matches) drawerOpen = false;
      if (focusNavigation || focusMenu) {
        await tick();
        if (width.matches === event.matches && (document.activeElement === focused || document.activeElement === document.body)) {
          (focusNavigation ? navigationPanel : drawerButton).focus();
        }
      }
    };
    color.addEventListener('change', onColorChange);
    width.addEventListener('change', onWidthChange);
    navigationPanel.addEventListener('click', onNavigationClick);
    return () => {
      color.removeEventListener('change', onColorChange);
      width.removeEventListener('change', onWidthChange);
      navigationPanel.removeEventListener('click', onNavigationClick);
    };
  });

  function toggleTheme() {
    explicitPreference = true;
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('assetweave-theme', theme); } catch { /* In-memory choice still works. */ }
  }

  async function openDrawer() {
    drawerOpen = true;
    await tick();
    closeButton?.focus();
  }

  async function closeDrawer() {
    drawerOpen = false;
    await tick();
    if (narrow) drawerButton?.focus();
  }

  function onNavigationClick(event: MouseEvent) {
    if (narrow && event.target instanceof Element && event.target.closest('.nav-item:not(:disabled), a[href]')) {
      void closeDrawer();
    }
  }

  function trapDrawer(event: KeyboardEvent) {
    if (!drawerOpen || !narrow) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(navigationPanel.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )).filter((item) => item.getClientRects().length && !item.closest('[inert]'));
    if (!items.length) {
      event.preventDefault();
      navigationPanel.focus();
      return;
    }
    const first = items.at(0);
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!navigationPanel.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
</script>

<svelte:window onkeydown={trapDrawer} />

<div class="workbench-shell" data-theme={theme}>
  <header class="shell-header" inert={drawerOpen && narrow}>
    <button bind:this={drawerButton} class="menu-button icon-button" type="button" aria-label="Open project and asset navigation" aria-controls="workbench-navigation" aria-expanded={drawerOpen} onclick={openDrawer}>
      <span aria-hidden="true">☰</span>
    </button>
    <div class="shell-brand"><span class="brand-symbol" aria-hidden="true">A·W</span><span>AssetWeave</span></div>
    <div class="shell-heading"><span class="shell-context">{context}</span><strong>{title}</strong></div>
    <div class="shell-actions">
      <button type="button" class="quiet-button" onclick={onRefresh}>Refresh</button>
      {#if onCapture}<button type="button" class="primary-button" onclick={onCapture}>Capture artwork</button>{/if}
      <button type="button" class="quiet-button theme-button" onclick={toggleTheme} aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</button>
      <button type="button" class="quiet-button session-button" onclick={onDisconnect}>End session</button>
    </div>
  </header>

  {#if drawerOpen && narrow}
    <button class="drawer-backdrop" type="button" aria-label="Close navigation" onclick={closeDrawer}></button>
  {/if}

  <div class="shell-workspace">
    <aside bind:this={navigationPanel} id="workbench-navigation" class:drawer-open={drawerOpen} class="shell-navigation" aria-label="Project and asset navigation" tabindex="-1" inert={narrow && !drawerOpen}>
      <div class="drawer-heading"><strong>Navigation</strong><button bind:this={closeButton} class="icon-button" type="button" aria-label="Close navigation" onclick={closeDrawer}>×</button></div>
      {@render navigation()}
    </aside>
    <main class="shell-content" inert={drawerOpen && narrow}>
      {@render content()}
    </main>
    <aside class="shell-inspector" aria-label="Record details" inert={drawerOpen && narrow}>
      <details open={!narrow || inspectorExpanded} ontoggle={(event) => { if (narrow) inspectorExpanded = event.currentTarget.open; }}>
        <summary><span><strong>Record details</strong><small>Show or hide contextual information</small></span><span class="disclosure-chevron" aria-hidden="true">⌄</span></summary>
        <div class="inspector-body">{@render inspector()}</div>
      </details>
    </aside>
  </div>
</div>

<style>
  .workbench-shell { min-height: 100vh; min-height: 100dvh; min-width: 0; max-width: 100%; overflow-x: clip; display: flex; flex-direction: column; background: var(--canvas); color: var(--text); font: 14px/1.45 Inter, 'Segoe UI', system-ui, sans-serif; }
  .shell-header { min-height: 56px; flex: none; display: flex; align-items: center; gap: 16px; padding: 8px 20px; background: var(--chrome); border-bottom: 1px solid var(--line); }
  .shell-brand { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; font-size: 15px; font-weight: 650; }
  .brand-symbol { display: grid; place-items: center; width: 29px; height: 29px; border: 1px solid var(--accent); border-radius: 5px; color: var(--accent); font: 13px Georgia, serif; }
  .shell-heading { min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
  .shell-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
  .shell-context { color: var(--subtle); white-space: nowrap; font-size: 11px; font-weight: 650; letter-spacing: .075em; text-transform: uppercase; }
  .shell-actions { display: flex; align-items: center; gap: 7px; margin-left: auto; flex: none; }
  .shell-actions button { white-space: nowrap; }
  .menu-button, .drawer-heading { display: none; }
  .shell-workspace { flex: 1; min-height: 0; min-width: 0; display: grid; grid-template-columns: 214px minmax(0, 1fr) 318px; }
  .shell-navigation { min-width: 0; padding: 18px 10px 24px; background: var(--chrome); border-right: 1px solid var(--line); overflow: auto; }
  .shell-content { min-width: 0; padding: 22px 28px 40px; background: var(--canvas); overflow: auto; overflow-wrap: anywhere; }
  .shell-inspector { min-width: 0; background: var(--surface); border-left: 1px solid var(--line); overflow: auto; }
  .shell-inspector details { padding: 20px 18px 28px; }
  .shell-inspector summary { display: none; }
  .inspector-body { min-width: 0; overflow-wrap: anywhere; }
  .drawer-backdrop { display: none; }
  :global(body:has(.workbench-shell .drawer-open)) { overflow: hidden; }
  @media (max-width: 1320px) {
    .shell-workspace { grid-template-columns: 202px minmax(0, 1fr) 302px; }
    .shell-content { padding: 20px 22px 36px; }
    .shell-inspector details { padding: 20px 16px 26px; }
  }
  @media (max-width: 1080px) {
    .shell-header { gap: 10px; padding-inline: 14px; }
    .shell-context { display: none; }
  }
  @media (max-width: 900px) {
    .workbench-shell { min-height: 100dvh; }
    .shell-workspace { display: block; }
    .shell-content { overflow: visible; padding: 20px 22px 28px; }
    .menu-button { display: grid; place-items: center; flex: none; }
    .shell-navigation { position: fixed; z-index: 51; inset: 0 auto 0 0; width: min(280px, calc(100vw - 42px)); visibility: hidden; transform: translateX(-105%); transition: transform .18s ease; box-shadow: 6px 0 28px #0005; }
    .shell-navigation.drawer-open { visibility: visible; transform: translateX(0); }
    .drawer-backdrop { display: block; position: fixed; inset: 0; z-index: 50; border: 0; border-radius: 0; background: #101718af; }
    .drawer-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 16px; }
    .shell-inspector { border-left: 0; border-top: 1px solid var(--line); overflow: visible; }
    .shell-inspector details { padding: 0; }
    .shell-inspector summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; list-style: none; padding: 12px 22px; min-height: 64px; }
    .shell-inspector summary::-webkit-details-marker { display: none; }
    .shell-inspector summary strong, .shell-inspector summary small { display: block; }
    .shell-inspector summary small { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .shell-inspector details[open] .disclosure-chevron { transform: rotate(180deg); }
    .inspector-body { max-width: 690px; padding: 4px 22px 26px; }
  }
  @media (max-width: 620px) {
    .shell-header { flex-wrap: wrap; gap: 8px; padding: 8px 15px; }
    .shell-heading { margin-left: auto; }
    .shell-heading strong { max-width: 30vw; }
    .shell-actions { order: 2; width: 100%; justify-content: flex-end; flex-wrap: wrap; }
    .shell-actions button { min-height: 34px; }
    .shell-content { padding: 18px 15px 24px; }
    .shell-inspector summary { padding-inline: 15px; }
    .inspector-body { padding-inline: 15px; }
  }
  @media (prefers-reduced-motion: reduce) { .shell-navigation { transition: none; } }
</style>
