use std::fmt;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(4);

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 2 {
        eprintln!("usage: http-hc http://127.0.0.1:<port>/<path>");
        std::process::exit(2);
    }

    if let Err(err) = check_url(&args[1], DEFAULT_TIMEOUT) {
        eprintln!("healthcheck failed: {err}");
        std::process::exit(1);
    }
}

fn check_url(url: &str, timeout: Duration) -> Result<(), HealthcheckError> {
    let target = parse_loopback_http_url(url)?;
    let mut stream = TcpStream::connect_timeout(&target.addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        target.path,
        target.addr.port()
    );
    stream.write_all(request.as_bytes())?;

    let status_line = read_status_line(&mut stream)?;
    let status_line = std::str::from_utf8(&status_line)
        .map_err(|_| HealthcheckError::InvalidResponse("response is not utf-8"))?
        .lines()
        .next()
        .ok_or(HealthcheckError::InvalidResponse("missing status line"))?;
    let mut parts = status_line.split_whitespace();
    let _version = parts
        .next()
        .ok_or(HealthcheckError::InvalidResponse("missing http version"))?;
    let status = parts
        .next()
        .ok_or(HealthcheckError::InvalidResponse("missing status code"))?
        .parse::<u16>()
        .map_err(|_| HealthcheckError::InvalidResponse("invalid status code"))?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(HealthcheckError::UnhealthyStatus(status))
    }
}

fn read_status_line(stream: &mut TcpStream) -> Result<Vec<u8>, HealthcheckError> {
    let mut status_line = Vec::with_capacity(64);
    let mut byte = [0_u8; 1];
    while status_line.len() < 256 {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            break;
        }
        status_line.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(status_line);
        }
    }
    if status_line.is_empty() {
        return Err(HealthcheckError::InvalidResponse("empty response"));
    }
    Err(HealthcheckError::InvalidResponse(
        "status line is missing newline",
    ))
}

struct Target {
    addr: SocketAddr,
    path: String,
}

fn parse_loopback_http_url(url: &str) -> Result<Target, HealthcheckError> {
    let rest = url
        .strip_prefix("http://")
        .ok_or(HealthcheckError::InvalidUrl(
            "only http:// URLs are supported",
        ))?;
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) if !path.is_empty() => (authority, format!("/{path}")),
        Some((authority, _)) => (authority, "/".to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or(HealthcheckError::InvalidUrl("explicit port is required"))?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(HealthcheckError::InvalidUrl(
            "only loopback healthchecks are supported",
        ));
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| HealthcheckError::InvalidUrl("invalid port"))?;
    if port == 0 {
        return Err(HealthcheckError::InvalidUrl("port must be non-zero"));
    }
    Ok(Target {
        addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)),
        path,
    })
}

#[derive(Debug)]
enum HealthcheckError {
    Io(std::io::Error),
    InvalidResponse(&'static str),
    InvalidUrl(&'static str),
    UnhealthyStatus(u16),
}

impl fmt::Display for HealthcheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "{err}"),
            Self::InvalidResponse(reason) => write!(f, "invalid response: {reason}"),
            Self::InvalidUrl(reason) => write!(f, "invalid url: {reason}"),
            Self::UnhealthyStatus(status) => write!(f, "unhealthy HTTP status {status}"),
        }
    }
}

impl From<std::io::Error> for HealthcheckError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    #[test]
    fn parses_loopback_http_url() {
        let target = parse_loopback_http_url("http://127.0.0.1:8088/_healthz")
            .expect("loopback healthcheck URL should parse");
        assert_eq!(target.addr, "127.0.0.1:8088".parse().unwrap());
        assert_eq!(target.path, "/_healthz");

        let localhost = parse_loopback_http_url("http://localhost:8787/healthz")
            .expect("localhost healthcheck URL should parse");
        assert_eq!(localhost.addr, "127.0.0.1:8787".parse().unwrap());
        assert_eq!(localhost.path, "/healthz");
    }

    #[test]
    fn rejects_non_loopback_or_non_http_urls() {
        assert!(parse_loopback_http_url("https://127.0.0.1:8088/_healthz").is_err());
        assert!(parse_loopback_http_url("http://example.com:8088/_healthz").is_err());
        assert!(parse_loopback_http_url("http://127.0.0.1/_healthz").is_err());
        assert!(parse_loopback_http_url("http://127.0.0.1:0/_healthz").is_err());
    }

    #[test]
    fn accepts_successful_http_statuses() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should have addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("healthcheck should connect");
            let mut request = [0_u8; 256];
            let read = stream.read(&mut request).expect("request should read");
            let request = std::str::from_utf8(&request[..read]).expect("request should be utf8");
            assert!(request.starts_with("GET /healthz HTTP/1.1\r\n"));
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .expect("response should write");
        });

        check_url(
            &format!("http://127.0.0.1:{}/healthz", addr.port()),
            Duration::from_secs(1),
        )
        .expect("2xx health response should pass");
        handle.join().expect("server thread should finish");
    }

    #[test]
    fn accepts_fragmented_status_line() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should have addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("healthcheck should connect");
            let mut request = [0_u8; 256];
            let _ = stream.read(&mut request).expect("request should read");
            stream
                .write_all(b"HTTP/1.1 ")
                .expect("status part should write");
            stream
                .write_all(b"200 OK\r\n")
                .expect("status part should write");
            stream
                .write_all(b"Connection: close\r\n\r\n")
                .expect("headers should write");
        });

        check_url(
            &format!("http://127.0.0.1:{}/healthz", addr.port()),
            Duration::from_secs(1),
        )
        .expect("fragmented 2xx status line should pass");
        handle.join().expect("server thread should finish");
    }

    #[test]
    fn rejects_unhealthy_http_statuses() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should have addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("healthcheck should connect");
            let mut request = [0_u8; 256];
            let _ = stream.read(&mut request).expect("request should read");
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
                .expect("response should write");
        });

        let err = check_url(
            &format!("http://127.0.0.1:{}/healthz", addr.port()),
            Duration::from_secs(1),
        )
        .expect_err("5xx health response should fail");
        assert!(matches!(err, HealthcheckError::UnhealthyStatus(503)));
        handle.join().expect("server thread should finish");
    }

    #[test]
    fn rejects_redirect_statuses() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should have addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("healthcheck should connect");
            let mut request = [0_u8; 256];
            let _ = stream.read(&mut request).expect("request should read");
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: /healthz\r\nConnection: close\r\n\r\n")
                .expect("response should write");
        });

        let err = check_url(
            &format!("http://127.0.0.1:{}/healthz", addr.port()),
            Duration::from_secs(1),
        )
        .expect_err("3xx health response should fail");
        assert!(matches!(err, HealthcheckError::UnhealthyStatus(302)));
        handle.join().expect("server thread should finish");
    }
}
