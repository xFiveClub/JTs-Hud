<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { socket } from '../../../socket'
import { useConfirmation } from '@renderer/composables/useConfirmation'
import BaseButton from '@renderer/components/base/BaseButton.vue'
import BaseInput from '@renderer/components/base/BaseInput.vue'
import BaseCheckbox from '@renderer/components/base/BaseCheckbox.vue'

interface RecorderStatus {
  recording: boolean
  recordingName: string | null
  recordedFrames: number
  replaying: boolean
  replayName: string | null
  replayPaused: boolean
  replaySpeed: number
  replayPositionMs: number
}

const status = ref<RecorderStatus | null>(null)
const recordings = ref<{ name: string; sizeBytes: number; modifiedAt: number }[]>([])
const label = ref('')
const simulate = ref(true)
const speed = ref(1)
const error = ref<string | null>(null)

const SPEEDS = [0.5, 1, 2, 4, 8]

const refresh = async () => {
  status.value = await window.api.recorder.status()
  recordings.value = await window.api.recorder.list()
}

const run = async (fn: () => Promise<unknown>) => {
  error.value = null
  try {
    await fn()
  } catch (err: any) {
    error.value = String(err?.message ?? err).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      ''
    )
  }
  await refresh()
}

const startRecording = () => run(() => window.api.recorder.start(label.value.trim() || undefined))
const stopRecording = () => run(() => window.api.recorder.stop())
const play = (name: string) =>
  run(() => window.api.recorder.replay(name, { speed: speed.value, simulate: simulate.value }))
const togglePause = () => run(() => window.api.recorder.pause(!status.value?.replayPaused))
const stopReplay = () => run(() => window.api.recorder.stopReplay())
const setSpeed = (s: number) => {
  speed.value = s
  if (status.value?.replaying) run(() => window.api.recorder.speed(s))
}
const { confirm } = useConfirmation()
const remove = async (name: string) => {
  if (await confirm(`Delete recording ${name}?`)) run(() => window.api.recorder.remove(name))
}
const openFolder = () => window.api.recorder.openFolder()

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + ' MB'

const onStatus = (s: RecorderStatus) => {
  const finished =
    (status.value?.recording && !s.recording) || (status.value?.replaying && !s.replaying)
  status.value = s
  if (finished) refresh()
}

onMounted(() => {
  refresh()
  socket.on('recorder:status', onStatus)
})
onUnmounted(() => socket.off('recorder:status', onStatus))
</script>

<template>
  <div class="bg-zinc-800 border border-zinc-700 rounded-xl p-4 space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-zinc-300">Record &amp; replay GSI</h3>
      <BaseButton size="xs" variant="ghost" @click="openFolder">Open folder</BaseButton>
    </div>
    <p class="text-xs text-zinc-500">
      Record a match (or a demo played in CS2) and replay it later without the game: the HUD, Live
      view and director all receive it as if it were live. Use it to tune the director and position
      overlays.
    </p>

    <!-- Recording -->
    <div
      v-if="status?.recording"
      class="flex items-center gap-3 px-3 py-2 rounded-lg bg-red-900/20 border border-red-700/40"
    >
      <span class="size-2.5 rounded-full bg-red-500 animate-pulse"></span>
      <span class="text-sm text-red-200 flex-1 truncate"
        >Recording {{ status.recordingName }} · {{ status.recordedFrames }} frames</span
      >
      <BaseButton size="sm" variant="danger" @click="stopRecording">Stop</BaseButton>
    </div>
    <div v-else class="flex items-end gap-2">
      <div class="flex-1">
        <BaseInput
          v-model="label"
          size="sm"
          placeholder="Label (optional), e.g. final-mirage"
          :disabled="!!status?.replaying"
        />
      </div>
      <BaseButton size="sm" @click="startRecording" :disabled="!!status?.replaying"
        >● Record</BaseButton
      >
    </div>

    <!-- Replay controls -->
    <div
      v-if="status?.replaying"
      class="px-3 py-2 rounded-lg bg-blue-900/20 border border-blue-700/40 space-y-2"
    >
      <div class="flex items-center gap-3">
        <span class="text-sm text-blue-200 flex-1 truncate">
          {{ status.replayPaused ? 'Paused' : 'Replaying' }} {{ status.replayName }} ·
          {{ mmss(status.replayPositionMs) }}
        </span>
        <BaseButton size="sm" @click="togglePause">{{
          status.replayPaused ? 'Resume' : 'Pause'
        }}</BaseButton>
        <BaseButton size="sm" variant="danger" @click="stopReplay">Stop</BaseButton>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-zinc-500">Speed</span>
      <BaseButton
        v-for="s in SPEEDS"
        :key="s"
        size="xs"
        :variant="(status?.replaying ? status.replaySpeed : speed) === s ? 'primary' : 'secondary'"
        @click="setSpeed(s)"
        >{{ s }}×</BaseButton
      >
      <div class="ml-auto">
        <BaseCheckbox
          v-model="simulate"
          size="sm"
          label="Simulate (don't move CS2 camera)"
          :disabled="!!status?.replaying"
        />
      </div>
    </div>

    <p v-if="error" class="text-xs text-red-400">{{ error }}</p>

    <!-- Recordings list -->
    <div
      v-if="recordings.length"
      class="max-h-56 overflow-y-auto divide-y divide-zinc-700/60 border border-zinc-700 rounded-lg"
    >
      <div
        v-for="r in recordings"
        :key="r.name"
        class="flex items-center gap-2 px-3 py-1.5 text-sm"
      >
        <span class="flex-1 truncate text-zinc-300" :title="r.name">{{
          r.name.replace('.jsonl.gz', '')
        }}</span>
        <span class="text-xs text-zinc-500 shrink-0">{{ mb(r.sizeBytes) }}</span>
        <BaseButton size="xs" @click="play(r.name)" :disabled="!!status?.recording"
          >Play</BaseButton
        >
        <BaseButton size="xs" variant="ghost" @click="remove(r.name)" title="Delete">✕</BaseButton>
      </div>
    </div>
    <p v-else class="text-xs text-zinc-600">No recordings yet.</p>
  </div>
</template>
