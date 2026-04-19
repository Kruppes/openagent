<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- List view -->
    <template v-if="!editingPersona">
      <PageHeader :title="$t('personas.title')" :subtitle="$t('personas.subtitle')">
        <template #actions>
          <Button @click="showCreateDialog = true">
            <AppIcon name="add" class="mr-1 h-4 w-4" />
            {{ $t('personas.createNew') }}
          </Button>
        </template>
      </PageHeader>

      <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto p-6">
        <!-- Multi-persona disabled banner -->
        <Alert v-if="!multiPersonaEnabled" variant="info" class="mb-4">
          <AlertDescription class="flex items-center justify-between">
            <span>{{ $t('personas.multiPersonaDisabled') }}</span>
            <Button as-child variant="outline" size="sm" class="ml-2 shrink-0">
              <NuxtLink to="/settings?tab=agent">
                {{ $t('personas.goToSettings') }}
              </NuxtLink>
            </Button>
          </AlertDescription>
        </Alert>

        <!-- Error banner -->
        <Alert v-if="error" variant="destructive" class="mb-4">
          <AlertDescription class="flex items-center justify-between">
            <span>{{ error }}</span>
            <button
              type="button"
              class="ml-2 opacity-70 transition-opacity hover:opacity-100"
              :aria-label="$t('aria.closeAlert')"
              @click="error = null"
            >
              <AppIcon name="close" class="h-4 w-4" />
            </button>
          </AlertDescription>
        </Alert>

        <!-- Success banner -->
        <Alert v-if="successMessage" variant="success" class="mb-4">
          <AlertDescription class="flex items-center justify-between">
            <span>{{ successMessage }}</span>
            <button
              type="button"
              class="ml-2 opacity-70 transition-opacity hover:opacity-100"
              :aria-label="$t('aria.closeAlert')"
              @click="successMessage = null"
            >
              <AppIcon name="close" class="h-4 w-4" />
            </button>
          </AlertDescription>
        </Alert>

        <!-- Loading -->
        <div v-if="loading && personas.length === 0" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
          <span class="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground mr-2" />
          {{ $t('common.loading') }}
        </div>

        <!-- Empty state -->
        <div
          v-else-if="personas.length === 0"
          class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground"
        >
          <AppIcon name="bot" size="xl" class="h-12 w-12 opacity-40" />
          <p class="text-sm">{{ $t('personas.empty') }}</p>
          <Button @click="showCreateDialog = true">
            {{ $t('personas.createNew') }}
          </Button>
        </div>

        <!-- Personas grid -->
        <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="persona in personas"
            :key="persona.id"
            class="group flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
          >
            <!-- Header -->
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h3 class="truncate text-base font-semibold text-foreground">
                    {{ persona.id }}
                  </h3>
                  <Badge v-if="persona.id === 'main'" variant="outline" class="shrink-0">
                    {{ $t('personas.mainBadge') }}
                  </Badge>
                </div>
              </div>

              <!-- Actions dropdown (not for main if no actions needed) -->
              <DropdownMenu v-if="persona.id !== 'main'">
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="$t('aria.userMenu')" class="opacity-0 group-hover:opacity-100 transition-opacity">
                    <AppIcon name="moreVertical" class="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="startEdit(persona.id)">
                    <AppIcon name="edit" class="h-4 w-4" />
                    {{ $t('personas.edit') }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive @click="personaToDelete = persona.id">
                    <AppIcon name="trash" class="h-4 w-4" />
                    {{ $t('personas.delete') }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <!-- Status badges -->
            <div class="mt-3 flex flex-wrap gap-1.5">
              <Badge v-if="persona.hasTelegramBinding" variant="success" class="text-xs">
                <AppIcon name="send" size="sm" class="mr-1" />
                {{ $t('personas.telegramBound') }}
              </Badge>
              <Badge v-else variant="outline" class="text-xs">
                {{ $t('personas.telegramNotBound') }}
              </Badge>
              <Badge variant="outline" class="text-xs">
                {{ $t('personas.filesCount', { count: persona.fileCount }) }}
              </Badge>
            </div>

            <!-- Edit button -->
            <div class="mt-4 pt-3 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                class="w-full"
                @click="startEdit(persona.id)"
              >
                <AppIcon name="edit" size="sm" class="mr-1" />
                {{ $t('personas.edit') }}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Edit view -->
    <template v-else>
      <PageHeader :title="$t('personas.editTitle', { id: editingPersona })" :subtitle="$t('personas.editDescription')">
        <template #actions>
          <Button variant="outline" @click="cancelEdit">
            {{ $t('personas.back') }}
          </Button>
          <Button :disabled="saving" @click="handleSave">
            <span
              v-if="saving"
              class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground mr-1"
              aria-hidden="true"
            />
            {{ $t('common.save') }}
          </Button>
        </template>
      </PageHeader>

      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-4xl px-6 py-6">
          <!-- Error banner -->
          <Alert v-if="error" variant="destructive" class="mb-4">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <!-- Success banner -->
          <Alert v-if="successMessage" variant="success" class="mb-4">
            <AlertDescription>{{ successMessage }}</AlertDescription>
          </Alert>

          <!-- Loading -->
          <div v-if="editLoading" class="flex flex-col gap-4">
            <Skeleton class="h-24 w-full rounded-lg" />
            <Skeleton class="h-24 w-full rounded-lg" />
            <Skeleton class="h-24 w-full rounded-lg" />
          </div>

          <!-- File editors -->
          <div v-else-if="editForm" class="flex flex-col gap-6">
            <div v-for="fileSpec in fileSpecs" :key="fileSpec.key" class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <Label :for="`file-${fileSpec.key}`" class="font-semibold">
                  {{ $t(fileSpec.labelKey) }}
                </Label>
                <span class="font-mono text-xs text-muted-foreground">{{ fileSpec.fileName }}</span>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t(fileSpec.hintKey) }}</p>
              <textarea
                :id="`file-${fileSpec.key}`"
                v-model="editForm[fileSpec.key as keyof typeof editForm]"
                class="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                :rows="fileSpec.rows"
                spellcheck="false"
              />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Create dialog -->
    <Dialog :open="showCreateDialog" @update:open="(v: boolean) => { if (!v) showCreateDialog = false }">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('personas.createTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('personas.createDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-4 py-4">
          <div class="flex flex-col gap-2">
            <Label for="new-persona-id">{{ $t('personas.idLabel') }}</Label>
            <Input
              id="new-persona-id"
              v-model="newPersonaId"
              :placeholder="$t('personas.idPlaceholder')"
              class="font-mono"
              @keydown.enter.prevent="handleCreate"
            />
            <p class="text-xs text-muted-foreground">{{ $t('personas.idHint') }}</p>
            <p v-if="createError" class="text-xs text-destructive">{{ createError }}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="showCreateDialog = false">
            {{ $t('common.cancel') }}
          </Button>
          <Button :disabled="creating || !newPersonaId.trim()" @click="handleCreate">
            <span
              v-if="creating"
              class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground mr-1"
              aria-hidden="true"
            />
            {{ $t('personas.createNew') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!personaToDelete"
      :title="$t('personas.delete')"
      :description="$t('personas.deleteConfirm', { id: personaToDelete ?? '' })"
      :confirm-label="$t('personas.delete')"
      destructive
      :loading="deleting"
      @confirm="handleDelete"
      @cancel="personaToDelete = null"
    />
  </div>
</template>

<script setup lang="ts">
import type { PersonaFiles } from '~/api/personas'

/* ── Auth ── */
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

/* ── i18n ── */
const { t } = useI18n()

/* ── State ── */
const {
  personas,
  loading,
  error,
  fetchPersonas,
  getPersona,
  updatePersona,
  createPersona,
  deletePersona,
} = usePersonas()

const successMessage = ref<string | null>(null)

/* ── Multi-persona enabled check ── */
const { settings, fetchSettings } = useSettings()
const multiPersonaEnabled = computed(() => settings.value?.multiPersona?.enabled ?? false)

/* ── Editing state ── */
const editingPersona = ref<string | null>(null)
const editForm = ref<PersonaFiles | null>(null)
const editLoading = ref(false)
const saving = ref(false)

/* ── Create dialog ── */
const showCreateDialog = ref(false)
const newPersonaId = ref('')
const createError = ref<string | null>(null)
const creating = ref(false)

/* ── Delete state ── */
const personaToDelete = ref<string | null>(null)
const deleting = ref(false)

/* ── File specs for editor ── */
const fileSpecs = [
  { key: 'identity', fileName: 'IDENTITY.md', labelKey: 'personas.fileIdentity', hintKey: 'personas.fileIdentityHint', rows: 5 },
  { key: 'soul', fileName: 'SOUL.md', labelKey: 'personas.fileSoul', hintKey: 'personas.fileSoulHint', rows: 12 },
  { key: 'user', fileName: 'USER.md', labelKey: 'personas.fileUser', hintKey: 'personas.fileUserHint', rows: 6 },
  { key: 'tools', fileName: 'TOOLS.md', labelKey: 'personas.fileTools', hintKey: 'personas.fileToolsHint', rows: 6 },
  { key: 'agents', fileName: 'AGENTS.md', labelKey: 'personas.fileAgents', hintKey: 'personas.fileAgentsHint', rows: 6 },
  { key: 'heartbeat', fileName: 'HEARTBEAT.md', labelKey: 'personas.fileHeartbeat', hintKey: 'personas.fileHeartbeatHint', rows: 6 },
]

/* ── Actions ── */
async function startEdit(id: string) {
  editingPersona.value = id
  editLoading.value = true
  error.value = null
  successMessage.value = null

  const persona = await getPersona(id)
  if (persona) {
    editForm.value = { ...persona.files }
  }
  editLoading.value = false
}

function cancelEdit() {
  editingPersona.value = null
  editForm.value = null
  error.value = null
  successMessage.value = null
}

async function handleSave() {
  if (!editingPersona.value || !editForm.value) return
  saving.value = true
  error.value = null
  successMessage.value = null

  const result = await updatePersona(editingPersona.value, editForm.value)
  saving.value = false

  if (result) {
    successMessage.value = t('personas.saveSuccess')
    editForm.value = { ...result.files }
    setTimeout(() => { successMessage.value = null }, 3000)
  }
}

async function handleCreate() {
  const id = newPersonaId.value.trim().toLowerCase()
  if (!id) return

  // Basic validation
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(id) && id.length > 1) {
    createError.value = t('personas.idHint')
    return
  }
  if (id.length < 2) {
    createError.value = t('personas.idHint')
    return
  }

  creating.value = true
  createError.value = null

  const result = await createPersona(id)
  creating.value = false

  if (result) {
    showCreateDialog.value = false
    newPersonaId.value = ''
    successMessage.value = t('personas.saveSuccess')
    setTimeout(() => { successMessage.value = null }, 3000)
    // Open editor for the new persona
    await startEdit(id)
  } else {
    createError.value = error.value
  }
}

async function handleDelete() {
  if (!personaToDelete.value) return
  deleting.value = true

  const success = await deletePersona(personaToDelete.value)
  deleting.value = false
  personaToDelete.value = null

  if (success) {
    successMessage.value = t('personas.deleteSuccess')
    setTimeout(() => { successMessage.value = null }, 3000)
  }
}

/* ── Init ── */
onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([
    fetchPersonas(),
    fetchSettings(),
  ])
})
</script>
