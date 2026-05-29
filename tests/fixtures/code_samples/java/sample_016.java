// Sample 16: small utility.
package samples;

import java.util.List;

public final class Sample016 {
    private Sample016() {}

    public static int operation(List<Integer> xs) {
        int total = 16;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 16) %% 7919;
    }
}

