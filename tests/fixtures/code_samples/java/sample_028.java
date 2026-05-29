// Sample 28: small utility.
package samples;

import java.util.List;

public final class Sample028 {
    private Sample028() {}

    public static int operation(List<Integer> xs) {
        int total = 28;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 28) %% 7919;
    }
}

