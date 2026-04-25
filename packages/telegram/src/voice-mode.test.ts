import { describe, it, expect, beforeEach } from 'vitest'
import { VoiceModeManager } from './voice-mode.js'

describe('VoiceModeManager', () => {
  let mgr: VoiceModeManager

  beforeEach(() => {
    mgr = new VoiceModeManager()
  })

  describe('getStatus', () => {
    it('returns default state for unknown user', () => {
      const status = mgr.getStatus('user1')
      expect(status.toggleActive).toBe(false)
      expect(status.nextAsVoice).toBe(false)
    })
  })

  describe('setNextAsVoice', () => {
    it('sets one-shot voice flag', () => {
      mgr.setNextAsVoice('user1')
      expect(mgr.getStatus('user1').nextAsVoice).toBe(true)
    })

    it('does not affect toggle state', () => {
      mgr.setNextAsVoice('user1')
      expect(mgr.getStatus('user1').toggleActive).toBe(false)
    })
  })

  describe('enableToggle / disableToggle', () => {
    it('enables persistent voice mode', () => {
      mgr.enableToggle('user1')
      expect(mgr.getStatus('user1').toggleActive).toBe(true)
    })

    it('disables persistent voice mode', () => {
      mgr.enableToggle('user1')
      mgr.disableToggle('user1')
      expect(mgr.getStatus('user1').toggleActive).toBe(false)
    })

    it('disableToggle also clears nextAsVoice', () => {
      mgr.setNextAsVoice('user1')
      mgr.disableToggle('user1')
      expect(mgr.getStatus('user1').nextAsVoice).toBe(false)
    })
  })

  describe('shouldSendAsVoice', () => {
    it('returns false by default', () => {
      expect(mgr.shouldSendAsVoice('user1', 100, true)).toBe(false)
    })

    it('returns true when nextAsVoice is set', () => {
      mgr.setNextAsVoice('user1')
      expect(mgr.shouldSendAsVoice('user1', 100, false)).toBe(true)
    })

    it('returns true when toggle is active', () => {
      mgr.enableToggle('user1')
      expect(mgr.shouldSendAsVoice('user1', 100, false)).toBe(true)
    })

    it('returns true for context-auto when last was voice and response is short', () => {
      mgr.setLastMessageWasVoice('user1', true)
      expect(mgr.shouldSendAsVoice('user1', 300, true)).toBe(true)
    })

    it('returns false for context-auto when response is too long', () => {
      mgr.setLastMessageWasVoice('user1', true)
      expect(mgr.shouldSendAsVoice('user1', 600, true)).toBe(false)
    })

    it('returns false for context-auto when disabled', () => {
      mgr.setLastMessageWasVoice('user1', true)
      expect(mgr.shouldSendAsVoice('user1', 300, false)).toBe(false)
    })

    it('returns false for context-auto when last was text', () => {
      mgr.setLastMessageWasVoice('user1', false)
      expect(mgr.shouldSendAsVoice('user1', 300, true)).toBe(false)
    })
  })

  describe('consumeNextAsVoice', () => {
    it('clears the one-shot flag', () => {
      mgr.setNextAsVoice('user1')
      mgr.consumeNextAsVoice('user1')
      expect(mgr.getStatus('user1').nextAsVoice).toBe(false)
    })

    it('does not affect toggle state', () => {
      mgr.enableToggle('user1')
      mgr.setNextAsVoice('user1')
      mgr.consumeNextAsVoice('user1')
      expect(mgr.getStatus('user1').toggleActive).toBe(true)
    })
  })

  describe('shouldShowServiceWarning', () => {
    it('returns true on first call', () => {
      expect(mgr.shouldShowServiceWarning('user1')).toBe(true)
    })

    it('returns false on immediate subsequent call', () => {
      mgr.shouldShowServiceWarning('user1')
      expect(mgr.shouldShowServiceWarning('user1')).toBe(false)
    })
  })

  describe('reset', () => {
    it('clears all state for a user', () => {
      mgr.enableToggle('user1')
      mgr.setNextAsVoice('user1')
      mgr.reset('user1')
      expect(mgr.getStatus('user1').toggleActive).toBe(false)
      expect(mgr.getStatus('user1').nextAsVoice).toBe(false)
    })
  })

  describe('size', () => {
    it('tracks number of users with state', () => {
      expect(mgr.size).toBe(0)
      mgr.setNextAsVoice('user1')
      expect(mgr.size).toBe(1)
      mgr.enableToggle('user2')
      expect(mgr.size).toBe(2)
    })
  })

  describe('isolation', () => {
    it('does not mix state between users', () => {
      mgr.enableToggle('user1')
      mgr.setNextAsVoice('user2')
      expect(mgr.getStatus('user1').toggleActive).toBe(true)
      expect(mgr.getStatus('user1').nextAsVoice).toBe(false)
      expect(mgr.getStatus('user2').toggleActive).toBe(false)
      expect(mgr.getStatus('user2').nextAsVoice).toBe(true)
    })
  })
})
