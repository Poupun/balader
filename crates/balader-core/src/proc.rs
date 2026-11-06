//! Child-process helpers. yt-dlp is a PyInstaller program that spawns its own
//! children (python, ffmpeg), so cancelling must kill the whole tree:
//! a process group on macOS/Linux, `taskkill /T` on Windows. On Windows every
//! spawn also gets CREATE_NO_WINDOW so no console flashes on screen.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::{Child, Command};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // Force UTF-8 out of the Python side so titles survive on every OS.
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run the child in its own process group so the whole tree can be signalled.
pub fn isolate(cmd: &mut Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Kill a child and everything it spawned. Best effort, never panics.
pub async fn kill_tree(child: &mut Child) {
    let Some(pid) = child.id() else { return };
    #[cfg(unix)]
    {
        // SAFETY: plain syscalls with a pid we own; a negative pid targets the group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_millis(1500), child.wait()).await.is_err() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let mut tk = std::process::Command::new("taskkill");
        {
            use std::os::windows::process::CommandExt;
            tk.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = tk.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
}

pub struct Output {
    pub status: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Run to completion with a timeout, capturing output (lossy UTF-8).
pub async fn run(program: &Path, args: &[String], timeout: Duration) -> std::io::Result<Output> {
    let mut cmd = command(program);
    isolate(&mut cmd);
    cmd.args(args);
    let mut child = cmd.spawn()?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let read_out = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buf).await;
        buf
    });
    let read_err = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut buf).await;
        buf
    });
    let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            kill_tree(&mut child).await;
            (None, true)
        }
    };
    let out = read_out.await.unwrap_or_default();
    let err = read_err.await.unwrap_or_default();
    Ok(Output {
        status: status.and_then(|s| s.code()),
        success: status.map(|s| s.success()).unwrap_or(false),
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        timed_out,
    })
}
