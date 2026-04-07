<!--
  SalesMemoryPluginSettingsModal — kept for backwards compatibility but no longer
  used in the plugins page. SalesMemory settings are now in Settings > SalesMemory.
-->
<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) onCancel() }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ $t('salesMemory.settings.title') }}</DialogTitle>
        <DialogDescription>{{ $t('salesMemory.settings.description') }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-5" @submit.prevent="handleSave">
        <!-- ── Provider Dropdown ──────────────────────────────────────────────── -->
        <div class="flex flex-col gap-1.5">
          <Label for="sm-provider">{{ $t('salesMemory.settings.provider') }}</Label>
          <Select v-model="form.provider">
            <SelectTrigger id="sm-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ollama">Ollama</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('salesMemory.settings.providerHint') }}</p>
        </div>

        <!-- ── Ollama Settings (shown when provider = ollama) ─────────────────── -->
        <div v-if="form.provider === 'ollama'" class="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t('salesMemory.settings.ollamaSection') }}
          </p>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-ollama-url">{{ $t('salesMemory.settings.ollamaUrl') }}</Label>
            <Input
              id="sm-ollama-url"
              v-model="form.ollamaUrl"
              type="url"
              placeholder="http://localhost:11434"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-ollama-model">{{ $t('salesMemory.settings.ollamaModel') }}</Label>
            <Input
              id="sm-ollama-model"
              v-model="form.ollamaModel"
              type="text"
              placeholder="llama3.2"
            />
          </div>
        </div>

        <!-- ── OpenAI Settings (shown when provider = openai) ────────────────── -->
        <div v-if="form.provider === 'openai'" class="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t('salesMemory.settings.openaiSection') }}
          </p>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-openai-key">{{ $t('salesMemory.settings.openaiKey') }}</Label>
            <Input
              id="sm-openai-key"
              v-model="form.openaiKey"
              type="password"
              placeholder="sk-..."
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-openai-model">{{ $t('salesMemory.settings.openaiModel') }}</Label>
            <Input
              id="sm-openai-model"
              v-model="form.openaiModel"
              type="text"
              placeholder="gpt-4o-mini"
            />
          </div>
        </div>

        <!-- ── Anthropic Settings (shown when provider = anthropic) ──────────── -->
        <div v-if="form.provider === 'anthropic'" class="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t('salesMemory.settings.anthropicSection') }}
          </p>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-anthropic-key">{{ $t('salesMemory.settings.anthropicKey') }}</Label>
            <Input
              id="sm-anthropic-key"
              v-model="form.anthropicKey"
              type="password"
              placeholder="sk-ant-..."
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="sm-anthropic-model">{{ $t('salesMemory.settings.anthropicModel') }}</Label>
            <Input
              id="sm-anthropic-model"
              v-model="form.anthropicModel"
              type="text"
              placeholder="claude-3-haiku-20240307"
            />
          </div>
        </div>

        <!-- ── Auto-Inject Section ────────────────────────────────────────────── -->
        <div class="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ $t('salesMemory.settings.autoInjectSection') }}
          </p>

          <!-- Auto-Inject Toggle -->
          <div class="flex items-center justify-between">
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-medium leading-none">{{ $t('salesMemory.settings.autoInject') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('salesMemory.settings.autoInjectHint') }}</span>
            </div>
            <Switch
              :checked="form.autoInject"
              :aria-label="$t('salesMemory.settings.autoInject')"
              @update:checked="(v: boolean) => (form.autoInject = v)"
            />
          </div>

          <!-- Max Results -->
          <div v-if="form.autoInject" class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
              <Label for="sm-inject-max">{{ $t('salesMemory.settings.injectMaxResults') }}</Label>
              <Input
                id="sm-inject-max"
                v-model.number="form.injectMaxResults"
                type="number"
                min="1"
                max="10"
              />
              <p class="text-xs text-muted-foreground">{{ $t('salesMemory.settings.injectMaxResultsHint') }}</p>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="sm-inject-threshold">{{ $t('salesMemory.settings.injectThreshold') }}</Label>
              <Input
                id="sm-inject-threshold"
                v-model.number="form.injectThreshold"
                type="number"
                min="-5.0"
                max="0.0"
                step="0.1"
              />
              <p class="text-xs text-muted-foreground">{{ $t('salesMemory.settings.injectThresholdHint') }}</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="onReset">
            {{ $t('salesMemory.settings.reset') }}
          </Button>
          <div class="flex-1" />
          <Button type="button" variant="outline" @click="onCancel">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="saving">
            {{ saving ? $t('common.saving') : $t('common.save') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useSalesMemorySettings } from '~/composables/useSalesMemorySettings'
import type { SalesMemoryPluginSettings } from '~/composables/useSalesMemorySettings'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const { settings, saveSettings, getDefaults } = useSalesMemorySettings()

const saving = ref(false)

const form = reactive<Omit<SalesMemoryPluginSettings, 'enabled'> & { enabled: boolean }>({
  enabled: settings.value.enabled,
  provider: settings.value.provider,
  ollamaUrl: settings.value.ollamaUrl,
  ollamaModel: settings.value.ollamaModel,
  openaiKey: settings.value.openaiKey,
  openaiModel: settings.value.openaiModel,
  anthropicKey: settings.value.anthropicKey,
  anthropicModel: settings.value.anthropicModel,
  autoInject: settings.value.autoInject,
  injectMaxResults: settings.value.injectMaxResults,
  injectThreshold: settings.value.injectThreshold,
})

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      form.enabled = settings.value.enabled
      form.provider = settings.value.provider
      form.ollamaUrl = settings.value.ollamaUrl
      form.ollamaModel = settings.value.ollamaModel
      form.openaiKey = settings.value.openaiKey
      form.openaiModel = settings.value.openaiModel
      form.anthropicKey = settings.value.anthropicKey
      form.anthropicModel = settings.value.anthropicModel
      form.autoInject = settings.value.autoInject
      form.injectMaxResults = settings.value.injectMaxResults
      form.injectThreshold = settings.value.injectThreshold
    }
  },
)

async function handleSave() {
  const d = getDefaults()
  const next: SalesMemoryPluginSettings = {
    enabled: form.enabled,
    provider: form.provider,
    ollamaUrl: form.ollamaUrl.trim() || d.ollamaUrl,
    ollamaModel: form.ollamaModel.trim() || d.ollamaModel,
    openaiKey: form.openaiKey,
    openaiModel: form.openaiModel.trim() || d.openaiModel,
    anthropicKey: form.anthropicKey,
    anthropicModel: form.anthropicModel.trim() || d.anthropicModel,
    autoInject: form.autoInject,
    injectMaxResults: Math.max(1, Math.min(10, form.injectMaxResults)),
    injectThreshold: Math.max(-5.0, Math.min(0.0, form.injectThreshold)),
  }

  saving.value = true
  try {
    await saveSettings(next)
  } finally {
    saving.value = false
  }

  emit('close')
}

function onCancel() {
  emit('close')
}

function onReset() {
  const d = getDefaults()
  form.enabled = d.enabled
  form.provider = d.provider
  form.ollamaUrl = d.ollamaUrl
  form.ollamaModel = d.ollamaModel
  form.openaiKey = d.openaiKey
  form.openaiModel = d.openaiModel
  form.anthropicKey = d.anthropicKey
  form.anthropicModel = d.anthropicModel
  form.autoInject = d.autoInject
  form.injectMaxResults = d.injectMaxResults
  form.injectThreshold = d.injectThreshold
}
</script>
