import { useRef, useState } from 'preact/hooks';

/** 非同期のコールバックから、描画を待たずに最新の値を読む。 */
export function useRefState<T>(initial: T): [T, (value: T) => void, { current: T }] {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const set = (next: T): void => {
    ref.current = next;
    setValue(next);
  };
  return [value, set, ref];
}
