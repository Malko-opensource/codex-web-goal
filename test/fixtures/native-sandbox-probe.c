#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Synthetic acceptance probe, never pointed at real secrets or user services. */
int main(int argc, char **argv) {
  if (argc != 2) return 10;
  FILE *file = fopen(argv[1], "r");
  if (file) { fclose(file); return 11; }
  file = fopen(argv[1], "w");
  if (file) { fclose(file); return 12; }
  if (getenv("WEB_GOAL_CANARY")) return 13;
  file = fopen("checks/check.txt", "w");
  if (file) { fclose(file); return 21; }
  if (!unlink("checks/check.txt")) return 22;
  if (!rename("checks", "moved-checks")) return 23;
  /* Ordinary snapshot scratch writes still work outside the pinned paths. */
  file = fopen("scratch.txt", "w"); if (!file) return 24;
  fclose(file); if (unlink("scratch.txt")) return 25;
  const char *services = getenv("WEB_GOAL_LOCAL_SERVICES");
  int fd = -1, port = 0;
  if (!services || sscanf(services, "[{\"fd\":%d,\"port\":%d}", &fd, &port) != 2) return 14;
  pid_t child = fork();
  if (child < 0) return 15;
  if (!child) {
    int client = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in address = {0}; address.sin_family = AF_INET;
    address.sin_port = htons(port); address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(client, (struct sockaddr *)&address, sizeof(address))) _exit(16);
    if (write(client, "ok", 2) != 2) _exit(17);
    close(client); _exit(0);
  }
  int peer = accept(fd, NULL, NULL); if (peer < 0) return 18;
  char bytes[2]; if (read(peer, bytes, 2) != 2 || memcmp(bytes, "ok", 2)) return 19;
  close(peer); close(fd);
  int status; waitpid(child, &status, 0);
  if (!WIFEXITED(status) || WEXITSTATUS(status)) return 20;
  puts("native-sandbox-pass"); return 0;
}
