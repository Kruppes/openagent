<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <PageHeader :title="$t('providers.title')" :subtitle="$t('providers.subtitle')">
      <template #actions>
        <Button @click="openCreate">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('providers.addProvider') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col p-6">
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

      <!-- Success banner (test result) -->
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

      <!-- Loading state -->
      <div
        v-if="loading && providers.length === 0"
        class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
      >
        {{ $t('logs.loading') }}
      </div>

      <!-- Empty state -->
      <div
        v-else-if="providers.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground"
      >
        <AppIcon name="plug" size="xl" class="h-12 w-12 opacity-40" />
        <p class="text-sm">{{ $t('providers.noProviders') }}</p>
        <Button @click="openCreate">
          {{ $t('providers.addProvider') }}
        </Button>
      </div>

      <!-- Providers table -->
      <div v-if="providers.length > 0" class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('providers.columns.name') }}</TableHead>
                <TableHead>{{ $t('providers.columns.cost') }}</TableHead>
                <TableHead>{{ $t('providers.columns.status') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="provider in sortedProviders" :key="provider.id">
                <!-- Provider row -->
                <TableRow
                  class="cursor-pointer"
                  @click="openEdit(provider)"
                >
                  <!-- Name + type -->
                  <TableCell>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-semibold text-foreground">{{ provider.name }}</span>
                        <template v-if="!hasMultipleModels(provider)">
                          <Badge v-if="provider.id === activeProviderId" variant="default" class="px-1.5 py-0 text-[10px]">
                            {{ $t('providers.active') }}
                          </Badge>
                          <Badge v-if="provider.id === fallbackProviderId" variant="outline" class="px-1.5 py-0 text-[10px]">
                            {{ $t('providers.fallback') }}
                          </Badge>
                        </template>
                      </div>
                      <span class="text-xs text-muted-foreground">
                        {{ getTypeLabel(provider.providerType) }}
                        <span v-if="!hasMultipleModels(provider)">
                          <span class="opacity-40">·</span>
                          {{ provider.defaultModel }}
                        </span>
                      </span>
                    </div>
                  </TableCell>

                  <!-- Cost (show for single-model providers only) -->
                  <TableCell>
                    <template v-if="!hasMultipleModels(provider)">
                      <div v-if="provider.cost" class="text-xs text-muted-foreground">
                        <div class="flex items-center gap-1">
                          <span class="text-foreground font-medium">${{ formatCost(provider.cost.input) }}</span>
                          <span class="opacity-40">/</span>
                          <span class="text-foreground font-medium">${{ formatCost(provider.cost.output) }}</span>
                        </div>
                        <span class="text-[10px]">{{ $t('providers.costPerMillion') }}</span>
                      </div>
                      <span v-else class="text-xs text-muted-foreground">{{ $t('providers.costNA') }}</span>
                    </template>
                  </TableCell>

                  <!-- Status (show for single-model providers only) -->
                  <TableCell>
                    <template v-if="!hasMultipleModels(provider)">
                      <div v-if="testingId === provider.id" class="flex items-center gap-1.5">
                        <span
                          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                          aria-hidden="true"
                        />
                        <span class="text-xs text-muted-foreground">{{ $t('providers.testing') }}</span>
                      </div>
                      <Badge v-else :variant="getStatusVariant(provider.status)">
                        {{ getStatusLabel(provider.status) }}
                      </Badge>
                    </template>
                  </TableCell>

                  <!-- Row actions -->
                  <TableCell class="text-right" @click.stop>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('providers.columns.actions')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <!-- Single-model providers: test + active/fallback actions on provider row -->
                        <template v-if="!hasMultipleModels(provider)">
                          <DropdownMenuItem @click="handleTest(provider.id)">
                            <AppIcon name="refresh" class="h-4 w-4" />
                            {{ $t('providers.testConnection') }}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            v-if="provider.id !== activeProviderId"
                            @click="handleActivate(provider.id)"
                          >
                            <AppIcon name="check" class="h-4 w-4" />
                            {{ $t('providers.setActive') }}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            v-if="provider.id !== activeProviderId && provider.id !== fallbackProviderId"
                            @click="handleSetFallback(provider.id)"
                          >
                            <AppIcon name="shield" class="h-4 w-4" />
                            {{ $t('providers.setFallback') }}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            v-if="provider.id === fallbackProviderId"
                            @click="handleSetFallback(null)"
                          >
                            <AppIcon name="close" class="h-4 w-4" />
                            {{ $t('providers.removeFallback') }}
                          </DropdownMenuItem>
                        </template>
                        <DropdownMenuItem @click="openEdit(provider)">
                          <AppIcon name="edit" class="h-4 w-4" />
                          {{ $t('users.edit') }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          :disabled="provider.id === activeProviderId"
                          @click="openDelete(provider)"
                        >
                          <AppIcon name="trash" class="h-4 w-4" />
                          {{ $t('providers.delete') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>

                <!-- Model sub-rows (shown when provider has multiple enabled models) -->
                <TableRow
                  v-for="modelId in getDisplayModels(provider)"
                  :key="`${provider.id}-${modelId}`"
                  class="bg-muted/30 hover:bg-muted/50"
                >
                  <!-- Model name (indented) -->
                  <TableCell>
                    <div class="flex items-center gap-2 pl-5">
                      <span class="text-xs text-muted-foreground">└</span>
                      <span class="text-sm text-foreground">{{ modelId }}</span>
                      <Badge v-if="isActiveModel(provider.id, modelId)" variant="default" class="px-1.5 py-0 text-[10px]">
                        {{ $t('providers.active') }}
                      </Badge>
                      <Badge v-if="isFallbackModel(provider.id, modelId)" variant="outline" class="px-1.5 py-0 text-[10px]">
                        {{ $t('providers.fallback') }}
                      </Badge>
                      <span v-if="modelId === provider.defaultModel" class="text-[10px] text-muted-foreground">
                        ({{ $t('providers.default') }})
                      </span>
                    </div>
                  </TableCell>

                  <!-- Cost -->
                  <TableCell>
                    <div v-if="provider.modelCosts?.[modelId]" class="text-xs text-muted-foreground">
                      <div class="flex items-center gap-1">
                        <span class="text-foreground font-medium">${{ formatCost(provider.modelCosts[modelId].input) }}</span>
                        <span class="opacity-40">/</span>
                        <span class="text-foreground font-medium">${{ formatCost(provider.modelCosts[modelId].output) }}</span>
                      </div>
                      <span class="text-[10px]">{{ $t('providers.costPerMillion') }}</span>
                    </div>
                    <span v-else class="text-xs text-muted-foreground">{{ $t('providers.costNA') }}</span>
                  </TableCell>

                  <!-- Status per model -->
                  <TableCell>
                    <div v-if="testingId === `${provider.id}:${modelId}`" class="flex items-center gap-1.5">
                      <span
                        class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                        aria-hidden="true"
                      />
                      <span class="text-xs text-muted-foreground">{{ $t('providers.testing') }}</span>
                    </div>
                    <Badge v-else :variant="getStatusVariant(provider.modelStatuses?.[modelId])">
                      {{ getStatusLabel(provider.modelStatuses?.[modelId]) }}
                    </Badge>
                  </TableCell>

                  <!-- Model actions -->
                  <TableCell class="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('providers.columns.actions')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem @click="handleTestModel(provider.id, modelId)">
                          <AppIcon name="refresh" class="h-4 w-4" />
                          {{ $t('providers.testConnection') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="!isActiveModel(provider.id, modelId)"
                          @click="handleActivateModel(provider.id, modelId)"
                        >
                          <AppIcon name="check" class="h-4 w-4" />
                          {{ $t('providers.setActive') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="!isFallbackModel(provider.id, modelId) && !isActiveModel(provider.id, modelId)"
                          @click="handleSetFallbackModel(provider.id, modelId)"
                        >
                          <AppIcon name="shield" class="h-4 w-4" />
                          {{ $t('providers.setFallback') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="isFallbackModel(provider.id, modelId)"
                          @click="handleSetFallback(null)"
                        >
                          <AppIcon name="close" class="h-4 w-4" />
                          {{ $t('providers.removeFallback') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>

                <!-- Single model badge row for providers with only one model -->
                <!-- (badges shown inline on the provider row itself, handled via isActiveModel/isFallbackModel for single models) -->
              </template>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <ProviderFormDialog
    :open="showForm"
    :mode="formMode"
    :provider="editingProvider"
    :presets="presets"
    @close="closeForm"
    @submit="handleSubmit"
    @oauth-complete="closeForm"
  />

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('providers.delete')"
    :description="$t('providers.deleteConfirm', { name: deleteTarget?.name ?? '' })"
    :confirm-label="$t('providers.deleteConfirmButton')"
    :cancel-label="$t('providers.deleteCancel')"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />
</template>

<script setup lang="ts">
import type { Provider } from '~/composables/useProviders'
import type { ProviderFormPayload } from '~/components/ProviderFormDialog.vue'

const { t } = useI18n()

const {
  providers,
  activeProviderId,
  activeModelId,
  fallbackProviderId,
  fallbackModelId,
  presets,
  loading,
  error,
  testingId,
  fetchProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  activateProvider,
  setFallbackProvider,
} = useProviders()

/* ── State ── */
const showForm = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingProvider = ref<Provider | null>(null)
const deleteTarget = ref<Provider | null>(null)
const successMessage = ref<string | null>(null)

const sortedProviders = computed(() =>
  [...providers.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)



onMounted(() => {
  fetchProviders()
})

/* ── Helpers ── */
function getTypeLabel(providerType: string): string {
  const preset = presets.value[providerType]
  return preset?.label ?? providerType
}

function getStatusVariant(status?: string): 'success' | 'destructive' | 'muted' {
  switch (status) {
    case 'connected': return 'success'
    case 'error': return 'destructive'
    default: return 'muted'
  }
}

function formatCost(value: number): string {
  if (value >= 1) return value.toFixed(2)
  if (value >= 0.01) return value.toFixed(2)
  return value.toFixed(3)
}

function hasMultipleModels(provider: Provider): boolean {
  return (provider.enabledModels?.length ?? 0) > 1
}

function getDisplayModels(provider: Provider): string[] {
  if (!hasMultipleModels(provider)) return []
  return provider.enabledModels ?? [provider.defaultModel]
}

function isActiveModel(providerId: string, modelId: string): boolean {
  if (providerId !== activeProviderId.value) return false
  const aModel = activeModelId.value
  // For single-model providers: show badge on provider row, not model row
  const provider = providers.value.find(p => p.id === providerId)
  if (!hasMultipleModels(provider!)) {
    return true // badge is on provider row
  }
  if (!aModel) {
    return modelId === provider?.defaultModel
  }
  return aModel === modelId
}

function isFallbackModel(providerId: string, modelId: string): boolean {
  if (providerId !== fallbackProviderId.value) return false
  const fbModel = fallbackModelId.value
  const provider = providers.value.find(p => p.id === providerId)
  if (!hasMultipleModels(provider!)) {
    return true
  }
  if (!fbModel) {
    return modelId === provider?.defaultModel
  }
  return fbModel === modelId
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
}

function autoHideSuccess() {
  setTimeout(() => { successMessage.value = null }, 4000)
}

/* ── Create / Edit ── */
function openCreate() {
  formMode.value = 'create'
  editingProvider.value = null
  showForm.value = true
}

function openEdit(provider: Provider) {
  formMode.value = 'edit'
  editingProvider.value = provider
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingProvider.value = null
}

async function handleSubmit(payload: ProviderFormPayload) {
  if (formMode.value === 'edit' && editingProvider.value) {
    const input: Record<string, string | number | string[] | undefined> = {
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl,
      defaultModel: payload.defaultModel,
      enabledModels: payload.enabledModels,
      degradedThresholdMs: payload.degradedThresholdMs,
    }
    if (payload.apiKey) {
      input.apiKey = payload.apiKey
    }
    const result = await updateProvider(editingProvider.value.id, input)
    if (result) closeForm()
  } else {
    const result = await addProvider({
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl || undefined,
      apiKey: payload.apiKey || undefined,
      defaultModel: payload.defaultModel,
      enabledModels: payload.enabledModels,
      degradedThresholdMs: payload.degradedThresholdMs,
    })
    if (result) closeForm()
  }
}

/* ── Delete ── */
function openDelete(provider: Provider) {
  deleteTarget.value = provider
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const success = await deleteProvider(deleteTarget.value.id)
  if (success) {
    deleteTarget.value = null
  }
}

/* ── Test / Activate ── */
async function handleTest(id: string) {
  const result = await testProvider(id)
  if (result.success) {
    successMessage.value = result.message ?? t('providers.testSuccess')
  } else {
    error.value = result.error ?? t('providers.testFailed')
  }
  autoHideSuccess()
}

async function handleTestModel(providerId: string, modelId: string) {
  const result = await testProvider(providerId, modelId)
  if (result.success) {
    successMessage.value = result.message ?? t('providers.testSuccess')
  } else {
    error.value = result.error ?? t('providers.testFailed')
  }
  autoHideSuccess()
}

async function handleActivate(id: string) {
  await activateProvider(id)
  await fetchProviders()
}

async function handleActivateModel(providerId: string, modelId: string) {
  await activateProvider(providerId, modelId)
  await fetchProviders()
}

async function handleSetFallback(id: string | null) {
  await setFallbackProvider(id)
  await fetchProviders()
}

async function handleSetFallbackModel(providerId: string, modelId: string) {
  await setFallbackProvider(providerId, modelId)
  await fetchProviders()
}
</script>
