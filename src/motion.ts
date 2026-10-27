import { useEffect, useRef, useState } from 'react'

/**
 * UIKit-style springs, authored as response + damping ratio.
 *
 * A cubic-bezier cannot carry momentum: when a target changes mid-flight it either jumps or
 * restarts from zero. This solver keeps the current position *and* velocity, so retargeting
 * (tap a second segment while the pill is still moving) hands the motion over instead of
 * replaying it. That is the single behaviour that makes iOS controls feel like objects.
 */
export type SpringPreset = { response: number; damping: number }

export const SPRING = {
  // Matches WinZal's tab pill (0.24 s, bounce 0.10): quick, ~0.5% overshoot.
  snappy: { response: 0.24, damping: 0.9 } as SpringPreset,
  // Shape changes (cards, sheets): 0.36 s, bounce 0.12, no visible wobble.
  morph: { response: 0.36, damping: 0.88 } as SpringPreset,
  // Critically damped, for anything large that must not bounce.
  smooth: { response: 0.46, damping: 1.0 } as SpringPreset,
  // Playful confirmation only.
  bouncy: { response: 0.42, damping: 0.76 } as SpringPreset,
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Animates a number towards `target` with a spring and returns the current value.
 * The value and velocity survive retargeting, so callers never reset the animation.
 */
export function useSpring(target: number, preset: SpringPreset = SPRING.snappy): number {
  const { response, damping } = preset
  const omega = (2 * Math.PI) / Math.max(0.05, response)
  const stiffness = omega * omega
  const dampingCoef = 2 * damping * omega

  const x = useRef(target)
  const v = useRef(0)
  const frame = useRef(0)
  const [value, setValue] = useState(target)

  useEffect(() => {
    if (prefersReducedMotion()) {
      x.current = target
      v.current = 0
      setValue(target)
      return
    }

    let last = performance.now()
    const tick = (now: number) => {
      // Clamp dt so a background tab that wakes up does not explode the integration.
      const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000))
      last = now
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
      const h = dt / steps
      for (let i = 0; i < steps; i += 1) {
        const accel = -stiffness * (x.current - target) - dampingCoef * v.current
        v.current += accel * h
        x.current += v.current * h
      }
      // Settle: sub-pixel and effectively stopped.
      if (Math.abs(v.current) < 0.01 && Math.abs(x.current - target) < 0.0005) {
        x.current = target
        v.current = 0
        setValue(target)
        return
      }
      setValue(x.current)
      frame.current = requestAnimationFrame(tick)
    }

    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [target, stiffness, dampingCoef])

  return value
}
