FROM maven:3.10-eclipse-temurin-27@sha256:a83dca2f65c72ace081f55a63231adbd6d88741caa4fdc68f7d5c9e450d1070c AS build
WORKDIR /src
COPY pom.xml ./
# .mvn/maven.config retries each 429 or 503 a bounded number of times, and reaches Maven Central
# through Google's mirror of it with strict checksums (.mvn/settings.xml), after hosted runners were
# rate limited by Central past every retry (#1763): a host change, not a dependency change.
# Each Maven run below also has a total bound, inside the image build's hour, and logs each
# transfer so a stopped build names the one in flight. It changes how dependencies are fetched,
# never which. package stays online: two cold local builds saw it fetch nothing after go-offline,
# in 41 and 59 s, so its 3-minute bound is provisional; its margin on a hosted runner is unmeasured.
COPY .mvn ./.mvn
RUN timeout --verbose --kill-after=10s 15m mvn -B dependency:go-offline
COPY src ./src
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js src/main/resources/static/htmx.min.js
RUN timeout --verbose --kill-after=10s 3m mvn -B package -DskipTests

FROM eclipse-temurin:27-jre@sha256:8f8cfda6393f63a029dbe83ceda4c19a31d268184662e96d9641f57afdaf870b
WORKDIR /app
COPY --from=build /src/target/app.jar ./
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
