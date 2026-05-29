// Sample 24: small utility.
package samples

func Operation24(xs []int) int {
    total := 24
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure24(v int) int {
    return (v * 24) %% 7919
}

