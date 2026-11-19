<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import BaseButton from '@renderer/components/base/BaseButton.vue'
import BaseInput from '@renderer/components/base/BaseInput.vue'
import BaseSelect from '@renderer/components/base/BaseSelect.vue'

interface MapZone {
  name: string
  x: number
  y: number
  z: number
  radius: number
  site?: boolean
}

const props = defineProps<{
  map: string | null
  players: {
    steamid: string
    name: string
    side: 'CT' | 'T'
    zone: string | null
    pos: number[] | null
  }[]
}>()

const mapName = computed(() => (props.map ?? '').substring((props.map ?? '').lastIndexOf('/') + 1))
const zones = ref<MapZone[]>([])
const newName = ref('')
const newRadius = ref(400)
const newSite = ref(false)
const fromPlayer = ref<string | null>(null)
const importText = ref('')
const showImport = ref(false)
const message = ref<{ ok: boolean; text: string } | null>(null)

const flash = (ok: boolean, text: string) => {
  message.value = { ok, text }
  setTimeout(() => {
    if (message.value?.text === text) message.value = null
  }, 3000)
}

const load = async () => {
  zones.value = mapName.value ? await window.api.zones.get(mapName.value) : []
}
watch(mapName, load, { immediate: true })

const persist = async () => {
  if (!mapName.value) return
  zones.value = await window.api.zones.set(mapName.value, JSON.parse(JSON.stringify(zones.value)))
}

const playerOptions = computed(() =>
  props.players
    .filter((p) => p.pos)
    .map((p) => ({
      value: p.steamid,
      label: `${p.name} (${p.side})${p.zone ? ` · ${p.zone}` : ''}`
    }))
)

const addZone = async () => {
  const p = props.players.find((x) => x.steamid === fromPlayer.value)
  if (!p?.pos || !newName.value.trim()) return
  zones.value.push({
    name: newName.value.trim(),
    x: p.pos[0],
    y: p.pos[1],
    z: p.pos[2],
    radius: Number(newRadius.value) || 400,
    site: newSite.value || undefined
  })
  newName.value = ''
  newSite.value = false
  await persist()
  flash(true, 'Zone added')
}

const removeZone = async (i: number) => {
  zones.value.splice(i, 1)
  await persist()
}

const exportZones = async () => {
  await navigator.clipboard.writeText(await window.api.zones.export())
  flash(true, 'All map zones copied to clipboard as JSON')
}

const importZones = async () => {
  try {
    await window.api.zones.import(importText.value)
    importText.value = ''
    showImport.value = false
    await load()
    flash(true, 'Zones imported')
  } catch (err: any) {
    flash(
      false,
      String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    )
  }
}
</script>

<template>
  <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-zinc-300">
        Map zones <span v-if="mapName" class="text-zinc-500 font-normal">· {{ mapName }}</span>
      </h3>
      <div class="flex gap-1">
        <BaseButton size="xs" variant="ghost" @click="exportZones">Export</BaseButton>
        <BaseButton size="xs" variant="ghost" @click="showImport = !showImport">Import</BaseButton>
      </div>
    </div>
    <p class="text-xs text-zinc-500">
      Callouts let the AI say "stack in Banana" instead of raw coordinates, and name executes
      ("Execute · B site"). Spectate a player standing on the spot (live or in a replay), pick them
      and save the zone.
    </p>

    <div v-if="showImport" class="space-y-2">
      <textarea
        v-model="importText"
        rows="4"
        placeholder='{ "de_mirage": [ { "name": "A site", "x": 0, "y": 0, "z": 0, "radius": 500, "site": true } ] }'
        class="w-full bg-surface border border-zinc-700 rounded-lg text-xs font-mono p-2 text-text-main focus:outline-none focus:border-primary"
      />
      <BaseButton size="sm" @click="importZones" :disabled="!importText.trim()"
        >Import JSON</BaseButton
      >
    </div>

    <template v-if="mapName">
      <div class="grid grid-cols-[1fr_1fr_5rem] gap-2 items-end">
        <BaseInput v-model="newName" size="sm" label="Zone name" placeholder="e.g. Banana" />
        <BaseSelect
          :model-value="fromPlayer ?? undefined"
          @update:model-value="fromPlayer = $event as string | null"
          :options="playerOptions"
          size="sm"
          label="At position of"
          placeholder="Player…"
        />
        <BaseInput v-model="newRadius" size="sm" type="number" label="Radius" />
      </div>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none">
          <input type="checkbox" v-model="newSite" class="accent-violet-500" /> Bombsite
        </label>
        <BaseButton
          size="sm"
          class="ml-auto"
          @click="addZone"
          :disabled="!newName.trim() || !fromPlayer"
          >Add zone</BaseButton
        >
      </div>

      <div
        v-if="zones.length"
        class="max-h-48 overflow-y-auto divide-y divide-zinc-700/60 border border-zinc-700 rounded-lg"
      >
        <div v-for="(z, i) in zones" :key="i" class="flex items-center gap-2 px-3 py-1.5 text-sm">
          <span class="flex-1 truncate text-zinc-300">
            {{ z.name }} <span v-if="z.site" class="text-xs text-amber-400">site</span>
          </span>
          <span class="text-xs text-zinc-600 font-mono"
            >{{ Math.round(z.x) }}, {{ Math.round(z.y) }}, {{ Math.round(z.z) }}</span
          >
          <input
            v-model.number="z.radius"
            @change="persist"
            type="number"
            class="w-16 bg-surface border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-text-main"
            title="Radius"
          />
          <BaseButton size="xs" variant="ghost" @click="removeZone(i)" title="Delete">✕</BaseButton>
        </div>
      </div>
      <p v-else class="text-xs text-zinc-600">No zones for this map yet.</p>
    </template>
    <p v-else class="text-xs text-zinc-600">Waiting for GSI data to know the current map.</p>

    <p v-if="message" class="text-xs" :class="message.ok ? 'text-emerald-400' : 'text-red-400'">
      {{ message.text }}
    </p>
  </div>
</template>
