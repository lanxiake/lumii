import { describe, expect, it } from 'vitest'
import { isWithinActiveWindow } from './cron-scheduler'

/** 2026-08-05 是周三（getDay()=3） */
const wed = (hour: number) => new Date(2026, 7, 5, hour, 0, 0)
/** 2026-08-08 是周六（getDay()=6） */
const sat = (hour: number) => new Date(2026, 7, 8, hour, 0, 0)

describe('isWithinActiveWindow', () => {
  it('未配置窗口时恒放行', () => {
    expect(isWithinActiveWindow({}, wed(3))).toBe(true)
    expect(isWithinActiveWindow({ active_days: null, active_hour_start: null, active_hour_end: null }, wed(3))).toBe(true)
  })

  it('按星期过滤', () => {
    const weekdays = { active_days: '1,2,3,4,5' }
    expect(isWithinActiveWindow(weekdays, wed(10))).toBe(true)
    expect(isWithinActiveWindow(weekdays, sat(10))).toBe(false)
  })

  it('时段左闭右开', () => {
    const job = { active_hour_start: 9, active_hour_end: 18 }
    expect(isWithinActiveWindow(job, wed(8))).toBe(false)
    expect(isWithinActiveWindow(job, wed(9))).toBe(true)
    expect(isWithinActiveWindow(job, wed(17))).toBe(true)
    expect(isWithinActiveWindow(job, wed(18))).toBe(false)
  })

  it('start === end 视为全天', () => {
    expect(isWithinActiveWindow({ active_hour_start: 0, active_hour_end: 0 }, wed(23))).toBe(true)
  })

  it('跨午夜窗口', () => {
    const night = { active_hour_start: 22, active_hour_end: 6 }
    expect(isWithinActiveWindow(night, wed(23))).toBe(true)
    expect(isWithinActiveWindow(night, wed(2))).toBe(true)
    expect(isWithinActiveWindow(night, wed(12))).toBe(false)
  })

  it('星期与时段同时生效', () => {
    const job = { active_days: '1,2,3,4,5', active_hour_start: 9, active_hour_end: 18 }
    expect(isWithinActiveWindow(job, wed(10))).toBe(true)
    expect(isWithinActiveWindow(job, wed(20))).toBe(false)
    expect(isWithinActiveWindow(job, sat(10))).toBe(false)
  })
})
