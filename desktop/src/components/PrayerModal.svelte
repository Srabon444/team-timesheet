<script>
  // { onclose } — reads and writes app.data.prayer itself; the parent only opens and closes it.
  import { app, savePrayerSettings } from "../lib/store.svelte.js";
  import * as prayer from "../lib/prayer.js";

  let { onclose } = $props();

  const stored = app.data.prayer || prayer.prayerDefaults();
  let enabled = $state(!!stored.enabled);
  let city = $state(stored.city || "");
  let country = $state(stored.country || "");
  let status = $state("");
  let statusKind = $state("");
  let checking = $state(false);
  //* A city the API has actually answered for, this session. Null means Save can only re-use
  //* whatever is already stored.
  let verified = $state(null);
  let preview = $state(null);

  const canSave = $derived(!!verified || !!stored.city);

  async function check() {
    if (!city.trim() || !country.trim()) {
      status = "Enter both a city and a country.";
      statusKind = "err";
      return;
    }
    checking = true;
    status = "Checking…";
    statusKind = "";
    preview = null;
    try {
      const r = await prayer.fetchMonth(city.trim(), country.trim(), stored.method, stored.school);
      const times = r.days[prayer.dayKey(new Date())] || Object.values(r.days)[0] || {};
      verified = { ...r, city: city.trim(), country: country.trim() };
      const device = prayer.deviceTz();
      preview = {
        tz: r.tz,
        times: prayer.PRAYER_NAMES.map((n) => `${n} ${times[n] || "—"}`).join("   "),
        //! Aladhan answers 200 for a city it has never heard of, with times for somewhere else
        //! entirely. A timezone that isn't this device's is the one automatic tell there is.
        mismatch: device && r.tz && device !== r.tz ? device : "",
      };
      status = "Found. Check the times above, then Save.";
      statusKind = "ok";
    } catch (e) {
      verified = null;
      status = e.message || String(e);
      statusKind = "err";
    } finally {
      checking = false;
    }
  }

  function save() {
    const patch = { enabled };
    if (verified) {
      Object.assign(patch, {
        city: verified.city,
        country: verified.country,
        tz: verified.tz,
        days: verified.days,
        month: verified.month,
        notified: {}, //* a new city means today's marks no longer describe anything
      });
    }
    if (enabled && !(patch.city || stored.city)) {
      status = "Check a city first.";
      statusKind = "err";
      return;
    }
    savePrayerSettings(patch);
    onclose();
  }

  function onkeydown(e) {
    if (e.key === "Escape") onclose();
  }
</script>

<div class="overlay" role="dialog" onkeydown={onkeydown}>
  <div class="box">
    <h3>Prayer time reminders</h3>
    <label class="toggle">
      <input type="checkbox" bind:checked={enabled} />
      <span>Notify me at each prayer time</span>
    </label>

    <!--* Free text, not dropdowns: the Aladhan API publishes no country or city list to build
         them from, so the Check step below stands in for a picker. -->
    <label for="pcity">City</label>
    <input id="pcity" type="text" placeholder="Dhaka" bind:value={city} />
    <label for="pcountry">Country</label>
    <input id="pcountry" type="text" placeholder="Bangladesh" bind:value={country} />

    <button class="btn check" onclick={check} disabled={checking}>
      {checking ? "Checking…" : "Check times"}
    </button>

    {#if status}
      <p class={statusKind === "err" ? "status-err" : statusKind === "ok" ? "status-ok" : "muted"}>{status}</p>
    {/if}

    {#if preview}
      <div class="preview">
        <div>Resolved to {preview.tz || "an unknown timezone"}</div>
        <div class="times">{preview.times}</div>
        {#if preview.mismatch}
          <div class="warn">
            ⚠ This device is on {preview.mismatch}. If that city name was a typo these times
            belong to somewhere else — check them before saving.
          </div>
        {/if}
      </div>
    {/if}

    <p class="muted small">Karachi method, Hanafi Asr.</p>

    <div class="actions">
      <button class="btn" onclick={onclose}>Close</button>
      <button class="btn primary" onclick={save} disabled={!canSave}>Save</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 90;
    background: var(--overlay-bg);
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .box {
    width: 100%; max-width: 380px;
    max-height: 90vh; overflow-y: auto;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 22px;
  }
  h3 { margin: 0 0 6px; font-size: 17px; }
  label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--text-muted); }
  .toggle {
    display: flex; align-items: center; gap: 8px;
    margin: 14px 0 4px; font-size: 13px; color: var(--text-secondary); cursor: pointer;
  }
  .toggle input { margin: 0; }
  input[type="text"] {
    width: 100%; box-sizing: border-box;
    background: var(--bg-surface-2);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px; padding: 8px 10px; font-size: 13px;
  }
  .check { margin-top: 12px; }
  .preview {
    margin-top: 10px; padding: 10px 12px;
    background: var(--bg-surface-2);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 12.5px; color: var(--text-secondary);
  }
  .times { margin-top: 5px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .warn { margin-top: 7px; color: var(--danger-light); }
  .small { font-size: 11.5px; margin-top: 12px; }
  .actions { display: flex; gap: 10px; margin-top: 18px; }
  .actions .btn { flex: 1; }
</style>
