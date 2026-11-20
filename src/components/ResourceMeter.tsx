import { useLanguage } from '../utils/language';
import { useEffect, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';

type Sample = { cpu: number | null; memory: number | null };

function Trend({ values }: { values: number[] }) {
  if (values.length < 2) return <svg aria-hidden="true" viewBox="0 0 44 16" />;
  const low = Math.min(...values);
  const spread = Math.max(1, Math.max(...values) - low);
  const points = values.map((value, i) =>
    `${43 - (values.length - 1 - i) * 1.45},${14 - (value - low) / spread * 12}`
  ).join(' ');
  return <svg aria-hidden="true" viewBox="0 0 44 16"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

export function ResourceMeter() {
  const { t } = useLanguage();
  const [history, setHistory] = useState<Sample[]>([]);
  const desktop = Boolean(window.electronAPI);
  useEffect(() => {
    let active = true;
    let busy = false;
    let warmed = false;
    async function sample() {
      if (busy) return;
      busy = true;
      let next: Sample = { cpu: null, memory: null };
      try {
        if (window.electronAPI) {
          const usage = await window.electronAPI.resourceUsage();
          next = { cpu: warmed ? usage.cpu : null, memory: usage.memoryMiB };
          warmed = true;
        } else {
          const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
          if (heap) next.memory = heap.usedJSHeapSize / 1048576;
        }
      } catch {
        warmed = false;
      } finally {
        if (active) setHistory(previous => [...previous.slice(-29), next]);
        busy = false;
      }
    }
    void sample();
    const timer = window.setInterval(sample, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const last = history.at(-1);
  const memory = last?.memory;
  return <div className="resource-meter" role="group" aria-label={t("实时资源用量")}>
    {desktop && <span title={t("应用进程 CPU 总占用")}><Cpu size={14} /><b>{last?.cpu == null ? '—' : last.cpu.toFixed(1) + '%'}</b><Trend values={history.flatMap(s => s.cpu ?? [])} /></span>}
    <span title={t(desktop ? '应用进程工作集总和' : '浏览器 JavaScript 堆估算')}>
      <MemoryStick size={15} />{!desktop && <small>JS</small>}<b>{memory == null ? '—' : memory >= 1024 ? (memory / 1024).toFixed(2) + ' GiB' : Math.round(memory) + ' MiB'}</b>
      <Trend values={history.flatMap(s => s.memory ?? [])} />
    </span>
  </div>;
}
