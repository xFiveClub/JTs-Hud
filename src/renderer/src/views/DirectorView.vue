<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDirector, COMMAND_PRESETS } from '../features/director/composables/useDirector';
import DirectorRecorder from '../features/director/components/DirectorRecorder.vue';
import DirectorZones from '../features/director/components/DirectorZones.vue';
import BaseButton from '@renderer/components/base/BaseButton.vue';
import BaseBadge from '@renderer/components/base/BaseBadge.vue';
import BaseInput from '@renderer/components/base/BaseInput.vue';
import BaseCheckbox from '@renderer/components/base/BaseCheckbox.vue';

const {
  config,
  status,
  apiKeyInput,
  saving,
  toggling,
  testingAI,
  message,
  save,
  clearApiKey,
  toggle,
  testAI,
  setSimulation,
  toggleLock,
  nextCut,
  copyLookaheadCfg,
  overlayUrl,
  copyOverlayUrl,
  openOverlayPreview,
} = useDirector();

const lookaheadHost = ref('127.0.0.1');

// Edit timing values in seconds, store in ms
const seconds = (key: 'minShotMs' | 'maxShotMs' | 'deathHoldMs' | 'manualOverrideMs' | 'aiIntervalMs') =>
  computed({
    get: () => (config.value ? config.value[key] / 1000 : 0),
    set: (v: number | string) => {
      if (config.value) config.value[key] = Math.round(Number(v) * 1000);
    },
  });
const minShot = seconds('minShotMs');
const maxShot = seconds('maxShotMs');
const deathHold = seconds('deathHoldMs');
const manualOverride = seconds('manualOverrideMs');
const aiInterval = seconds('aiIntervalMs');
const marginPct = computed({
  get: () => (config.value ? Math.round(config.value.switchMargin * 100) : 0),
  set: (v: number | string) => {
    if (config.value) config.value.switchMargin = Number(v) / 100;
  },
});
const numberField = (key: 'lookaheadDelaySec' | 'lookaheadLeadSec') =>
  computed({
    get: () => config.value?.[key] ?? 0,
    set: (v: number | string) => {
      if (config.value) config.value[key] = Number(v);
    },
  });
const lookaheadDelay = numberField('lookaheadDelaySec');
const lookaheadLead = numberField('lookaheadLeadSec');

const isPreset = computed(() => COMMAND_PRESETS.some((p) => p.value === config.value?.commandTemplate));
const maxScore = computed(() => Math.max(1, ...(status.value?.scores.map((s) => s.score) ?? [1])));

const timeAgo = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};
</script>

<template>
  <div class="p-6 bg-surface text-zinc-200 min-h-screen">
    <!-- Header -->
    <div class="flex items-start justify-between mb-6 gap-4">
      <div>
        <h1 class="text-2xl font-bold text-text-main">AI Director</h1>
        <p class="text-zinc-400 text-sm mt-1">
          Automatic observer: follows fights, kills, plants, executes and clutches, and moves the CS2 camera over telnet.
          The optional AI layer reads each round and tells it who the story is about.
        </p>
        <div class="flex flex-wrap gap-2 mt-2" v-if="status">
          <BaseBadge v-if="status.simulation" variant="blue">Simulation · CS2 camera untouched</BaseBadge>
          <BaseBadge v-else :variant="status.netconConnected ? 'emerald' : 'red'">
            CS2 telnet {{ status.netconConnected ? 'connected' : 'offline' }} · {{ status.netconTarget }}
          </BaseBadge>
          <BaseBadge :variant="status.receivingGsi ? 'emerald' : 'zinc'">
            GSI {{ status.receivingGsi ? 'live' : 'no data' }}
          </BaseBadge>
          <BaseBadge v-if="status.lookahead.receiving" :variant="status.lookahead.active ? 'emerald' : 'amber'">
            Look-ahead {{ status.lookahead.active ? 'active' : 'receiving (set tv_delay to use it)' }}
          </BaseBadge>
          <BaseBadge v-if="status.phase" variant="blue">Phase: {{ status.phase }}</BaseBadge>
          <BaseBadge v-if="status.lockedOn" variant="orange">Locked on {{ status.lockedOn }}</BaseBadge>
          <BaseBadge v-if="status.pausedForMs > 0" variant="amber">
            Manual override · resumes in {{ Math.ceil(status.pausedForMs / 1000) }}s
          </BaseBadge>
        </div>
        <p class="text-xs text-zinc-600 mt-2">
          Shortcuts (work in-game): <kbd class="text-zinc-400">Alt+D</kbd> start/stop ·
          <kbd class="text-zinc-400">Alt+L</kbd> lock on current player · <kbd class="text-zinc-400">Alt+N</kbd> next cut now
        </p>
      </div>
      <div class="flex flex-col items-end gap-2 shrink-0">
        <BaseButton
          @click="toggle"
          :disabled="toggling"
          :variant="status?.enabled ? 'danger' : 'primary'"
          size="lg"
        >
          {{ status?.enabled ? 'Stop Director' : 'Start Director' }}
        </BaseButton>
        <div class="flex gap-2">
          <BaseButton size="sm" @click="toggleLock" :disabled="!status?.enabled">
            {{ status?.lockedOn ? 'Unlock' : 'Lock' }}
          </BaseButton>
          <BaseButton size="sm" @click="nextCut" :disabled="!status?.enabled">Next</BaseButton>
        </div>
        <BaseCheckbox
          :model-value="status?.simulation ?? false"
          @update:model-value="setSimulation"
          size="sm"
          label="Simulation"
        />
      </div>
    </div>

    <div
      v-if="status?.warning"
      class="mb-5 px-4 py-3 rounded-lg text-sm border bg-red-900/20 border-red-700/40 text-red-300"
    >
      {{ status.warning }}
    </div>
    <div
      v-if="message"
      class="mb-5 px-4 py-3 rounded-lg text-sm font-medium border"
      :class="message.ok
        ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
        : 'bg-red-900/30 border-red-700/50 text-red-300'"
    >
      {{ message.text }}
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <!-- ============ LIVE ============ -->
      <div class="flex flex-col gap-5 min-w-0">
        <!-- On camera -->
        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
          <div class="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-1">On camera</div>
          <div class="text-2xl font-bold text-text-main">{{ status?.observed?.name ?? '—' }}</div>
          <div v-if="status?.cuts[0]" class="text-sm text-zinc-400 mt-1">
            Last: <span class="text-zinc-200">{{ status.cuts[0].name }}</span> — {{ status.cuts[0].reason }}
          </div>
          <div v-if="status?.execute" class="text-sm text-amber-300 mt-1">⚑ {{ status.execute }}</div>
          <div v-if="status?.lookahead.predicted.length" class="text-sm text-emerald-300 mt-1">
            ⏩ Fight coming: {{ status.lookahead.predicted.join(', ') }}
          </div>
        </div>

        <!-- AI read -->
        <div v-if="status?.ai.enabled" class="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="text-xs font-semibold uppercase tracking-widest text-zinc-500">AI read of the round</div>
            <BaseBadge
              :variant="status.ai.state === 'error' ? 'red' : status.ai.state === 'thinking' ? 'amber' : 'emerald'"
            >
              {{ status.ai.state }}<template v-if="status.ai.latencyMs"> · {{ status.ai.latencyMs }} ms</template>
            </BaseBadge>
          </div>
          <p class="text-sm text-zinc-200">{{ status.ai.storyline ?? 'Waiting for the next plan…' }}</p>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <BaseBadge v-if="status.ai.focusSide" :variant="status.ai.focusSide === 'CT' ? 'blue' : 'orange'">
              Focus {{ status.ai.focusSide }}
            </BaseBadge>
            <BaseBadge v-for="w in status.ai.weights" :key="w.name" :variant="w.weight >= 1 ? 'emerald' : 'zinc'">
              {{ w.name }} ×{{ w.weight.toFixed(2) }}
            </BaseBadge>
          </div>
          <p v-if="status.ai.state === 'error'" class="text-xs text-red-400 mt-2 break-all">{{ status.ai.error }}</p>
        </div>

        <!-- Scores -->
        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
          <div class="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-3">Interest score (alive players)</div>
          <div v-if="!status?.scores.length" class="text-sm text-zinc-500">No live players.</div>
          <div v-for="s in status?.scores" :key="s.steamid" class="mb-2.5">
            <div class="flex items-center justify-between text-sm">
              <span class="flex items-center gap-2 min-w-0">
                <span
                  class="text-xs font-bold px-1.5 rounded"
                  :class="s.side === 'CT' ? 'bg-sky-900/50 text-sky-300' : 'bg-amber-900/50 text-amber-300'"
                >{{ s.side }}</span>
                <span class="truncate" :class="s.steamid === status?.observed?.steamid ? 'text-primary font-bold' : 'text-zinc-200'">
                  {{ s.name }}
                </span>
                <span v-if="status?.players.find((p) => p.steamid === s.steamid)?.zone" class="text-xs text-zinc-500">
                  {{ status?.players.find((p) => p.steamid === s.steamid)?.zone }}
                </span>
                <span v-if="s.inCombat" class="text-xs text-red-400 font-semibold">IN FIGHT</span>
              </span>
              <span class="font-mono text-zinc-400">{{ s.score }}</span>
            </div>
            <div class="h-1.5 bg-zinc-900 rounded mt-1 overflow-hidden">
              <div
                class="h-full rounded transition-all"
                :class="s.side === 'CT' ? 'bg-sky-500' : 'bg-amber-500'"
                :style="{ width: `${(s.score / maxScore) * 100}%` }"
              />
            </div>
            <div class="text-xs text-zinc-500 mt-0.5 truncate">{{ s.reasons.join(' · ') }}</div>
          </div>
        </div>

        <!-- Cut log -->
        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
          <div class="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-2">Cut log</div>
          <div v-if="!status?.cuts.length" class="text-sm text-zinc-500">No cuts yet.</div>
          <div v-for="(c, i) in status?.cuts" :key="i" class="text-sm flex gap-3 py-0.5">
            <span class="text-zinc-600 font-mono w-10 shrink-0 text-right">{{ timeAgo(c.at) }}</span>
            <span class="text-zinc-200 shrink-0">{{ c.name }}</span>
            <span class="text-zinc-500 truncate">{{ c.reason }}</span>
          </div>
        </div>

        <DirectorRecorder />
        <DirectorZones :map="status?.map ?? null" :players="status?.players ?? []" />
      </div>

      <!-- ============ SETTINGS ============ -->
      <div v-if="config" class="flex flex-col gap-5 min-w-0">
        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
          <h3 class="text-sm font-semibold text-zinc-300">Camera control</h3>
          <p class="text-xs text-zinc-500">
            Uses the telnet host/port from the Spectator Binds page. Launch CS2 with
            <code class="text-zinc-400">-netconport 2020</code> and spectate the match (GOTV or in-server observer).
          </p>
          <div>
            <label class="block text-xs font-semibold text-zinc-400 mb-1.5">Switch command</label>
            <div class="flex flex-wrap gap-2 mb-2">
              <BaseButton
                v-for="p in COMMAND_PRESETS"
                :key="p.value"
                size="sm"
                :variant="config.commandTemplate === p.value ? 'primary' : 'secondary'"
                @click="config.commandTemplate = p.value"
              >{{ p.label }}</BaseButton>
            </div>
            <BaseInput
              v-model="config.commandTemplate"
              :hint="isPreset ? 'Placeholders: {accountid} {steamid} {name} {slot}. You can chain commands with ;' : 'Custom command. Placeholders: {accountid} {steamid} {name} {slot}'"
            />
          </div>
          <BaseCheckbox
            v-model="config.disableGameAutodirector"
            label="Turn off CS2's own auto-director (spec_autodirector 0) on start"
          />
        </div>

        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4">
          <h3 class="text-sm font-semibold text-zinc-300 mb-3">Cut timing</h3>
          <div class="grid grid-cols-2 gap-3">
            <BaseInput v-model="minShot" type="number" label="Min shot length (s)" hint="Never cut sooner (except deaths, plant/defuse)" />
            <BaseInput v-model="maxShot" type="number" label="Max quiet shot (s)" hint="Rotate after this if nothing is happening" />
            <BaseInput v-model="deathHold" type="number" label="Hold after death (s)" hint="Then cut to the killer" />
            <BaseInput v-model="marginPct" type="number" label="Switch margin (%)" hint="How much better a player must be to cut" />
            <BaseInput v-model="manualOverride" type="number" label="Manual override pause (s)" hint="When you change camera yourself" />
          </div>
        </div>

        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
          <BaseCheckbox v-model="config.useAI" label="AI layer (OpenAI-compatible API)" />
          <p class="text-xs text-zinc-500">
            The AI does not pick each cut (too slow for a duel). Every few seconds and at key moments it reads the round
            and weights players for the rule engine. Works with OpenAI, OpenRouter, Ollama, LM Studio and any
            <code class="text-zinc-400">/chat/completions</code> endpoint.
          </p>
          <template v-if="config.useAI">
            <BaseInput v-model="config.llmBaseUrl" label="Base URL" placeholder="https://api.openai.com/v1" />
            <BaseInput v-model="config.llmModel" label="Model" placeholder="Model id, e.g. the fast/mini model of your provider" />
            <div>
              <BaseInput
                v-model="apiKeyInput"
                type="password"
                label="API key"
                :placeholder="config.llmApiKeySet ? '•••••••• saved — type to replace' : 'Paste your API key (leave empty for local servers)'"
                :hint="config.llmApiKeySet && !config.llmApiKeyEncrypted ? 'Warning: OS keychain unavailable, key stored unencrypted.' : 'Stored encrypted with the OS keychain. Never sent anywhere except the base URL above.'"
              />
              <BaseButton v-if="config.llmApiKeySet" size="xs" variant="ghost" class="mt-1" @click="clearApiKey">
                Remove saved key
              </BaseButton>
            </div>
            <BaseInput v-model="aiInterval" type="number" label="Re-read interval during the round (s)" hint="Plus freezetime, plant, execute and clutch moments. Lower = more API calls." />
            <BaseButton @click="testAI" :disabled="testingAI">
              {{ testingAI ? 'Testing…' : 'Save & test AI connection' }}
            </BaseButton>
          </template>
        </div>

        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
          <h3 class="text-sm font-semibold text-zinc-300">Look-ahead (anticipation)</h3>
          <p class="text-xs text-zinc-500">
            Pro observers watch through GOTV with <code class="text-zinc-400">tv_delay</code>. Run a second CS2 client
            <b>without delay</b> (e.g. an in-server spectator) with the cfg below: the director then sees fights before the
            broadcast and gets the camera there in time. Leave the delay at 0 to disable.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <BaseInput v-model="lookaheadDelay" type="number" label="Broadcast tv_delay (s)" hint="Must match the server's tv_delay" />
            <BaseInput v-model="lookaheadLead" type="number" label="Arrive early by (s)" hint="Camera reaches the player this long before the fight" />
          </div>
          <div class="flex items-end gap-2">
            <div class="flex-1">
              <BaseInput v-model="lookaheadHost" size="sm" label="This PC's address as seen by the look-ahead client" placeholder="127.0.0.1 or LAN IP" />
            </div>
            <BaseButton size="sm" @click="copyLookaheadCfg(lookaheadHost)">Copy look-ahead cfg</BaseButton>
          </div>
          <p class="text-xs text-zinc-600">
            Save it as <code class="text-zinc-400">gamestate_integration_jts_lookahead.cfg</code> in that client's
            <code class="text-zinc-400">csgo/cfg</code> folder.
          </p>
        </div>

        <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
          <h3 class="text-sm font-semibold text-zinc-300">Director overlay</h3>
          <p class="text-xs text-zinc-500">
            Add a second Browser Source (1920×1080) on top of the HUD. Optional URL params:
            <code class="text-zinc-400">ct=5d9cec&amp;t=e8b04a&amp;top=150&amp;bottom=250&amp;scale=1</code>.
          </p>
          <div class="flex items-center gap-2">
            <code class="flex-1 text-xs bg-zinc-950 border border-border rounded-lg px-2.5 py-1.5 text-zinc-400 truncate">{{ overlayUrl }}</code>
            <BaseButton size="sm" @click="copyOverlayUrl">Copy URL</BaseButton>
            <BaseButton size="sm" variant="ghost" @click="openOverlayPreview">Preview</BaseButton>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            <BaseCheckbox v-model="config.overlayFocusCard" size="sm" label="Player to watch (freezetime)" />
            <BaseCheckbox v-model="config.overlayClutch" size="sm" label="Clutch banner (1vX)" />
            <BaseCheckbox v-model="config.overlayStoryline" size="sm" label="AI storyline lower third" />
            <BaseCheckbox v-model="config.overlayExecute" size="sm" label="Execute alert" />
            <BaseCheckbox v-model="config.overlayReason" size="sm" label="Camera reason tag" />
          </div>
        </div>

        <div class="flex justify-end">
          <BaseButton variant="primary" @click="save" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save settings' }}
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
