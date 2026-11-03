import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SOURCE, LOCK, verifySource } from '../lab/source.mjs';

if (existsSync(SOURCE)) {
  verifySource();
  console.log(`已存在正确的源码基准：${SOURCE}`);
} else {
  execFileSync('git', ['clone', '--no-checkout', '--filter=blob:none', `${LOCK.repo}.git`, SOURCE], { stdio: 'inherit' });
  execFileSync('git', ['-C', SOURCE, 'checkout', '--detach', LOCK.commit], { stdio: 'inherit' });
  verifySource();
  console.log(`源码就绪：${LOCK.version} · ${LOCK.commit}`);
}
