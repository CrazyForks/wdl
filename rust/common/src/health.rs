use std::env;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const MAX_STATUS_LINE_BYTES: usize = 512;

pub fn healthcheck_http_200(port_env: &str, default_port: u16, path: &str) -> i32 {
    let port = env::var(port_env).unwrap_or_else(|_| default_port.to_string());
    let Ok(mut stream) = TcpStream::connect(format!("127.0.0.1:{port}")) else {
        return 1;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return 1;
    }
    let mut line = Vec::new();
    match read_status_line(&mut stream, &mut line) {
        Ok(()) if status_line_is_http_200(&line) => 0,
        _ => 1,
    }
}

fn read_status_line(stream: &mut impl Read, line: &mut Vec<u8>) -> std::io::Result<()> {
    let mut byte = [0_u8; 1];
    while line.len() < MAX_STATUS_LINE_BYTES {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            break;
        }
        line.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(());
        }
    }
    Ok(())
}

fn status_line_is_http_200(line: &[u8]) -> bool {
    let Ok(line) = std::str::from_utf8(line) else {
        return false;
    };
    let mut parts = line.trim_end_matches(['\r', '\n']).split_whitespace();
    let Some(version) = parts.next() else {
        return false;
    };
    let Some(status) = parts.next() else {
        return false;
    };
    version.starts_with("HTTP/") && status == "200"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_line_accepts_http_200_variants() {
        assert!(status_line_is_http_200(b"HTTP/1.1 200 OK\r\n"));
        assert!(status_line_is_http_200(b"HTTP/1.0 200 OK\n"));
        assert!(!status_line_is_http_200(
            b"HTTP/1.1 500 Internal Server Error\r\n"
        ));
        assert!(!status_line_is_http_200(b"not-http 200 OK\r\n"));
    }

    #[test]
    fn read_status_line_handles_fragmented_reads() {
        let mut reader = b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".as_slice();
        let mut line = Vec::new();
        read_status_line(&mut reader, &mut line).expect("status line should read");
        assert_eq!(line, b"HTTP/1.1 200 OK\r\n");
        assert!(status_line_is_http_200(&line));
    }
}
