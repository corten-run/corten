package bench.itempage;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        // Every upstream client (java.net.http, which RestClient uses here) must not reuse a pooled
        // connection idle for the 5 s keep-alive each benchmark upstream advertises: a read written
        // to a connection the upstream is closing is lost (bench/fullstack/README.md). The JDK keeps
        // one 30 s by default and has no per-client setting; it reads this property when the first
        // client is built. It drops an expired connection late: set to 4 s, it still reused
        // connections idle 5.9 to 6.1 s (bench/fullstack/idle-close.mjs), and at 1 s none past 5 s.
        System.setProperty("jdk.httpclient.keepalive.timeout", "1");
        SpringApplication.run(Application.class, args);
    }
}
